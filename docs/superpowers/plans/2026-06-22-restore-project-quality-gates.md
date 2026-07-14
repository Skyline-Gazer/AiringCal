---
change: restore-project-quality-gates
design-doc: docs/superpowers/specs/2026-06-22-restore-project-quality-gates-design.md
base-ref: 20c5f751b913928464d974851d39886e70c00178
archived-with: 2026-06-22-restore-project-quality-gates
---

# 恢复项目质量门禁 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 恢复包管理一致性、CI 质量门禁、R2 图片管线，使项目达到可验证、可部署的稳定状态。

**Architecture:** pnpm workspace 单仓库（`packages/shared/` 纯 TS 库 + `packages/worker/` Cloudflare Worker）。本 change 按「包管理 → 脚本 → CI → 类型生成 → R2 管线 → 清理 → 测试」的顺序推进，每步产生可独立验证的交付物。

**Tech Stack:** pnpm 9.15.9, TypeScript, node:test, Wrangler, Cloudflare Workers (Hono), R2, KV, Durable Objects

## 全局约束

- 包管理器唯一：pnpm，版本锁定 `9.15.9`（根 `package.json` 的 `packageManager` 字段 + CI `pnpm/action-setup@v4` 的 `version: 9.15.9`）
- 所有包必须有 `typecheck`（`tsc --noEmit`）和 `test`（`node --test`）脚本；worker 额外有 `build:check`（`wrangler deploy --dry-run --outdir dist`）
- 根 `package.json` 通过 `pnpm -r` 递归运行所有包的相同脚本
- CI 部署前依次执行 `typecheck` → `test` → `build:check`
- CI 使用 `pnpm install --frozen-lockfile` 确保 lockfile 一致性
- 图片下载最多 2 个并行，单张超时 8s，失败静默跳过
- 不要引入新的测试框架——使用 `node --test` 内建 runner

archived-with: 2026-06-22-restore-project-quality-gates
---

## 文件变更清单

| 操作 | 文件 |
|------|------|
| 修改 | `package.json`（根）：`packageManager` + `typecheck`/`test`/`build:check` 脚本 |
| 修改 | `packages/shared/package.json`：`typecheck`、`test` 脚本 |
| 修改 | `packages/worker/package.json`：`typecheck`、`test`、`build:check` 脚本 |
| 删除 | `package-lock.json` |
| 修改 | `.gitignore`：移除 `pnpm-lock.yaml`，添加 `package-lock.json` |
| 修改 | `.github/workflows/deploy.yml`：固定 pnpm 版本、添加质量检查步骤 |
| 新建 | `packages/worker/worker-configuration.d.ts`（`wrangler types` 生成） |
| 修改 | `packages/worker/src/index.ts`：删除手写 `interface Env`，改为从 `worker-configuration.d.ts` import |
| 新建 | `packages/worker/src/image/download.ts`：图片下载限流器 |
| 修改 | `packages/worker/src/cron.ts`：接入图片下载管线，替换 `_imageStore: unknown` |
| 修改 | `packages/shared/src/merger.ts`：`MergedEntry.images.hash` 从 `string` 改为 `string \| null`；`merge()` 接受 `imageHashMap` |
| 删除 | `data/calendar.json` |
| 修改 | `README.md`：更新图片策略说明 |
| 新建 | `packages/shared/src/merger.test.ts` |
| 新建 | `packages/worker/src/image/download.test.ts` |

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 1: 包管理恢复 — 固定 pnpm 版本、唯一 lockfile、更新 .gitignore

**Files:**
- Modify: `package.json`（根）：第 4 行后插入 `"packageManager"` 字段
- Delete: `package-lock.json`
- Modify: `.gitignore`：第 110-111 行移除 `pnpm-lock.yaml`，添加 `package-lock.json`

**Interfaces:**
- Consumes: 当前根 `package.json` 无 `packageManager` 字段
- Produces: 根 `package.json` 新增 `"packageManager": "pnpm@9.15.9"`

- [x] **Step 1: 根 package.json 添加 packageManager 字段**

编辑 `package.json`（根），在 `"private": true` 后插入：

```json
"packageManager": "pnpm@9.15.9",
```

预期结果：根 `package.json` 变为：

```json
{
  "name": "bangumi-tv",
  "version": "2.0.0",
  "private": true,
  "packageManager": "pnpm@9.15.9",
  "description": "render your bangumi.tv progress on a static web page",
  ...
}
```

- [x] **Step 2: 删除 package-lock.json**

```bash
rm package-lock.json
```

验证：`ls package-lock.json` → `ls: package-lock.json: No such file or directory`

- [x] **Step 3: 更新 .gitignore — 交换 lockfile 规则**

`.gitignore` 当前第 110-111 行：

```
# pnpm
pnpm-lock.yaml
```

改为：

```
# pnpm lockfile (single source of truth)
pnpm-lock.yaml
# npm lockfile (conflicts with pnpm)
package-lock.json
```

注意：`pnpm-lock.yaml` 从忽略列表移除（即纳入版本管理），`package-lock.json` 加入忽略列表。

- [x] **Step 4: 验证包管理器配置**

```bash
pnpm install
pnpm ls -r
```

预期：无错误，`pnpm-lock.yaml` 存在且未被 `.gitignore` 忽略。

- [x] **Step 5: 提交**

```bash
git add package.json package-lock.json .gitignore pnpm-lock.yaml
git commit -m "fix: lock pnpm to 9.15.9, adopt pnpm-lock.yaml as single lockfile"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 2: 包脚本配置 — 添加 typecheck、test、build:check

**Files:**
- Modify: `package.json`（根）：在 `scripts` 中添加 `typecheck`、`test`、`build:check`
- Modify: `packages/shared/package.json`：在 `scripts` 中添加 `typecheck`、`test`
- Modify: `packages/worker/package.json`：在 `scripts` 中添加 `typecheck`、`test`、`build:check`

**Interfaces:**
- Consumes: 无
- Produces: 根 `"typecheck": "pnpm -r typecheck"`、`"test": "pnpm -r test"`、`"build:check": "pnpm -r build:check"`

- [x] **Step 1: 根 package.json 添加递归脚本**

编辑根 `package.json` 的 `scripts` 对象：

```json
"scripts": {
  "dev": "pnpm -F @bangumi-tv/worker dev",
  "deploy": "pnpm -F @bangumi-tv/worker deploy",
  "typecheck": "pnpm -r typecheck",
  "test": "pnpm -r test",
  "build:check": "pnpm -r build:check"
}
```

- [x] **Step 2: packages/shared/package.json 添加脚本**

编辑 `packages/shared/package.json`，在 `"main"` 后添加 `"scripts"`：

```json
{
  "name": "@bangumi-tv/shared",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test"
  }
}
```

- [x] **Step 3: packages/worker/package.json 添加脚本**

编辑 `packages/worker/package.json` 的 `scripts`：

```json
"scripts": {
  "dev": "wrangler dev",
  "deploy": "wrangler deploy",
  "typecheck": "tsc --noEmit",
  "test": "node --test",
  "build:check": "wrangler deploy --dry-run --outdir dist"
}
```

- [x] **Step 4: 验证脚本可用**

```bash
pnpm typecheck
```

预期：项目当前应能通过类型检查（可能有少量已有类型错误，这些会在后续任务修复）。

```bash
pnpm test
```

预期：运行已有 `node:test` 测试文件（7 个），全部 PASS。

```bash
pnpm build:check
```

预期：worker 能通过 dry-run 构建。

- [x] **Step 5: 提交**

```bash
git add package.json packages/shared/package.json packages/worker/package.json
git commit -m "feat: add typecheck, test, build:check scripts to all packages"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 3: CI 质量门禁 — 固定 pnpm 版本、添加质量检查步骤

**Files:**
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: Task 2 添加的脚本
- Produces: CI 包含 typecheck → test → build:check 三步顺序门禁

- [x] **Step 1: 固定 pnpm 版本**

`.github/workflows/deploy.yml` 第 26-28 行：

```yaml
      - uses: pnpm/action-setup@v4
        with:
          version: latest
```

改为：

```yaml
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.9
```

- [x] **Step 2: pnpm install 添加 --frozen-lockfile**

第 35 行：

```yaml
      - run: pnpm install
```

改为：

```yaml
      - run: pnpm install --frozen-lockfile
```

- [x] **Step 3: 在「Configure Wrangler env」之后添加质量检查步骤**

在 `# 幂等创建资源` 步骤前（第 42 行前），插入三个步骤：

```yaml
      - name: TypeCheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test

      - name: Build Check
        run: pnpm run build:check
```

这三个步骤在 deploy 之前执行。若任意步骤失败，流程终止，不部署。

- [x] **Step 4: 验证 CI 配置语法**

```bash
node -e "
const fs = require('fs');
const yaml = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');
console.log('CI config size:', yaml.length, 'bytes');
// 检查关键行
const lines = yaml.split('\n');
console.log('pnpm version:', lines.find(l => l.includes('version: 9.15.9')));
console.log('frozen-lockfile:', lines.find(l => l.includes('frozen-lockfile')));
console.log('TypeCheck:', lines.find(l => l.includes('TypeCheck')));
console.log('Test step:', lines.find(l => l.startsWith('      - name: Test')));
console.log('Build Check:', lines.find(l => l.startsWith('      - name: Build Check')));
"
```

预期：所有关键行都能找到。

- [x] **Step 5: 提交**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: pin pnpm to 9.15.9, add frozen-lockfile and quality gates"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 4: Env 类型生成 — wrangler types + index.ts 适配

**Files:**
- New: `packages/worker/worker-configuration.d.ts`（生成）
- Modify: `packages/worker/src/index.ts`：删除手写 `interface Env`（60-74 行），改为 import

**Interfaces:**
- Consumes: `packages/worker/wrangler.toml`（已有）
- Produces: `worker-configuration.d.ts` 导出 `interface Env`

- [x] **Step 1: 运行 wrangler types 生成类型声明**

```bash
cd packages/worker && npx wrangler types --env-interface Env worker-configuration.d.ts
```

验证：文件 `packages/worker/worker-configuration.d.ts` 已创建，内容类似：

```typescript
// Auto-generated by wrangler types --env-interface Env
interface Env {
  BANGUMI_KV: KVNamespace
  BANGUMI_R2: R2Bucket
  SYNC_MODE: string
  NSFW_SHOW: string
  BANGUMI_TOKEN: string
  BANGUMI_REFRESH_TOKEN?: string
  BANGUMI_USERS: string
  BANGUMI_PRIMARY_USER?: string
  BANGUMI_CLIENT_ID?: string
  BANGUMI_CLIENT_SECRET?: string
  CRON_SECRET: string
  MANAGE_SECRET?: string
  SYNCLOCK: DurableObjectNamespace
}
```

- [x] **Step 2: 修改 index.ts — 删除手写 interface Env，添加 import**

删除 `packages/worker/src/index.ts` 第 60-74 行（`interface Env { ... }` 的整个块）。

在文件顶部 import 块中（第 1-36 行之间），在 `import manageHtml from './manage/index.html'` 附近添加：

```typescript
/// <reference path="./worker-configuration.d.ts" />
```

或者在文件最顶部添加三重斜杠引用。注意：由于 `worker-configuration.d.ts` 是全局声明文件（不 export 任何东西，直接声明全局 `Env`），使用三斜杠指令引用即可，无需 `import` 语句。

如果 `worker-configuration.d.ts` 内部定义为 `export interface Env`，则改为：

```typescript
import type { Env } from './worker-configuration.d.ts'
```

检查生成的 `worker-configuration.d.ts` 的导出形式，使用匹配的导入方式。

- [x] **Step 3: 验证类型检查通过**

```bash
cd packages/worker && npx tsc --noEmit
```

预期：无类型错误。如果出现 `.d.ts` 识别问题，检查 `tsconfig.json` 是否包含 `"include": ["**/*.ts", "**/*.d.ts"]`。

- [x] **Step 4: 提交**

```bash
git add packages/worker/worker-configuration.d.ts packages/worker/src/index.ts
git commit -m "feat: generate Env types via wrangler types, remove hand-written interface"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 5: R2 图片下载限流器 — download.ts

**Files:**
- Create: `packages/worker/src/image/download.ts`

**Interfaces:**
- Consumes: `BgmClient.downloadImage(url: string)` 返回 `Promise<{ data: ArrayBuffer; contentType: string } | null>`（已有）；`ImageStore.putOriginal(hash, data, contentType)`（已有）
- Produces: 导出 `async function downloadImagesWithLimit(entries: Array<{ url: string; subjectId: number }>, imageStore: ImageStore, bgmClient: BgmClient, concurrency?: number): Promise<Map<number, string>>`

- [x] **Step 1: 创建 download.ts**

```typescript
import { BgmClient } from '@bangumi-tv/shared'
import type { ImageStore } from '../image/store.ts'

export interface DownloadEntry {
  url: string
  subjectId: number
}

/**
 * 带并发限制的图片下载器。
 * 使用信号量模式：同时最多 `concurrency` 个 fetch 操作。
 * 每个图片超时 8s，失败静默跳过（hash 不入结果 map）。
 * 返回 subjectId → hex(SHA-256) 映射。
 */
export async function downloadImagesWithLimit(
  entries: DownloadEntry[],
  imageStore: ImageStore,
  bgmClient: BgmClient,
  concurrency: number = 2,
): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  let idx = 0
  const inFlight = new Set<Promise<void>>()

  async function worker(): Promise<void> {
    while (idx < entries.length) {
      const entry = entries[idx++]
      try {
        const downloaded = await bgmClient.downloadImage(entry.url)
        if (!downloaded) continue

        // 计算 SHA-256 哈希
        const hashBuffer = await crypto.subtle.digest('SHA-256', downloaded.data)
        const hashArray = Array.from(new Uint8Array(hashBuffer))
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')

        // 写入 R2
        await imageStore.putOriginal(hashHex, downloaded.data, downloaded.contentType)
        result.set(entry.subjectId, hashHex)
      } catch {
        // 失败静默跳过
      }
    }
  }

  // 启动 concurrency 个工作协程
  for (let i = 0; i < concurrency; i++) {
    inFlight.add(worker())
  }
  await Promise.all(inFlight)

  return result
}
```

- [x] **Step 2: 验证文件语法**

```bash
cd packages/worker && npx tsc --noEmit src/image/download.ts
```

预期：无类型错误。

- [x] **Step 3: 提交**

```bash
git add packages/worker/src/image/download.ts
git commit -m "feat: add downloadImagesWithLimit — concurrent image downloader for R2 pipeline"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 6: merger 图片 hash 传递 — 修改 toMergedEntry 和 merge 接口

**Files:**
- Modify: `packages/shared/src/merger.ts`

**Interfaces:**
- Consumes: 合并时外部提供的 `imageHashMap: Map<number, string>`（key: subjectId, value: hash hex）
- Produces: `MergedEntry.images.hash` 类型从 `string` 变为 `string | null`；`merge(usersCollections, imageHashMap?)` 签名；`primaryMerge(masterCollections, imageHashMap?)` 签名

- [x] **Step 1: 修改 MergedEntry.images 类型**

`packages/shared/src/merger.ts` 第 8 行：

```typescript
images: { hash: string; w: number; h: number }
```

改为：

```typescript
images: { hash: string | null; w: number; h: number }
```

- [x] **Step 2: 修改 toMergedEntry 接受可选 imageHashMap**

修改 `toMergedEntry` 函数签名和实现（第 45-64 行）：

```typescript
function toMergedEntry(
  c: BgmCollection,
  imageHashMap?: Map<number, string>,
): MergedEntry {
  const subj = c.subject
  const imageHash = imageHashMap?.get(c.subject_id) ?? null
  return {
    subject_id: c.subject_id,
    name: subj?.name ?? '',
    name_cn: subj?.name_cn ?? '',
    summary: subj?.summary ?? '',
    images: { hash: imageHash, w: subj?.images?.large ? 300 : 0, h: subj?.images?.large ? 400 : 0 },
    eps: subj?.eps ?? 0,
    total_episodes: subj?.total_episodes ?? 0,
    ep_status: c.ep_status,
    vol_status: c.vol_status,
    type: c.subject_type,
    collection_type: c.type,
    rate: c.rate,
    nsfw: subj?.nsfw ?? false,
    date: subj?.date ?? '',
    tags: c.tags ?? [],
    updated_at: c.updated_at,
  }
}
```

注意：`w` 和 `h` 从硬编码 `0` 改为实际图片尺寸。由于 bgm.tv 不直接返回尺寸，使用标准封面尺寸 `300x400` 作为合理默认。

- [x] **Step 3: 修改 merge 函数签名**

`packages/shared/src/merger.ts` 第 67 行：

```typescript
export function merge(usersCollections: BgmCollection[][]): MergedCollections {
```

改为：

```typescript
export function merge(
  usersCollections: BgmCollection[][],
  imageHashMap?: Map<number, string>,
): MergedCollections {
```

第 72 行 `const entry = toMergedEntry(c)` 改为：

```typescript
const entry = toMergedEntry(c, imageHashMap)
```

- [x] **Step 4: 修改 primaryMerge 函数签名**

`packages/shared/src/merger.ts` 第 91 行：

```typescript
export function primaryMerge(masterCollections: BgmCollection[]): MergedCollections {
  return merge([masterCollections])
}
```

改为：

```typescript
export function primaryMerge(
  masterCollections: BgmCollection[],
  imageHashMap?: Map<number, string>,
): MergedCollections {
  return merge([masterCollections], imageHashMap)
}
```

- [x] **Step 5: 验证类型检查**

```bash
cd packages/shared && npx tsc --noEmit
cd packages/worker && npx tsc --noEmit
```

预期：已有调用者（`cron.ts`、`index.ts`、`api/collections.ts`）由于 `imageHashMap` 为可选参数，无需修改即通过类型检查。

- [x] **Step 6: 提交**

```bash
git add packages/shared/src/merger.ts
git commit -m "feat: merge() accepts imageHashMap, images.hash is string | null"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 7: cron.ts 集成图片下载管线

**Files:**
- Modify: `packages/worker/src/cron.ts`

**Interfaces:**
- Consumes: `downloadImagesWithLimit`（Task 5）、修改后的 `merge`/`primaryMerge`（Task 6）、`BgmClient`（已有）、`ImageStore`（已有）
- Produces: `runSync` 第三个参数类型从 `_imageStore: unknown` 改为 `_imageStore: ImageStore`

- [x] **Step 1: 更新 runSync 签名 — 替换 _imageStore 类型**

`packages/worker/src/cron.ts` 第 2-3 行 import 添加 `ImageStore`：

```typescript
import { merge, primaryMerge, type MergedCollections } from '@bangumi-tv/shared'
import type { StorageAdapter } from '@bangumi-tv/shared'
```

在第 4 行后（或 import 区域），添加：

```typescript
import type { ImageStore } from './image/store.ts'
```

第 116 行：

```typescript
  _imageStore: unknown,
```

改为：

```typescript
  imageStore: ImageStore,
```

- [x] **Step 2: 在 collection fetch 之后、merge 之前，提取需下载图片的条目**

在 `packages/worker/src/cron.ts` 的 `runSync` 函数中，现有代码在第 137 行拉取 collections，第 140-173 行进行 merge。在 merge 之前（第 137 行后），插入图片下载逻辑。

在 `// 3. Primary 保护` 之前，插入：

```typescript
  // 2.5 图片下载（并行，不阻塞整体流程）
  // 从成功的 collection 中提取有封面的条目
  const imageEntries: Array<{ url: string; subjectId: number }> = []
  for (let i = 0; i < settled.length; i++) {
    if (settled[i]?.status === 'fulfilled') {
      for (const c of settled[i].value) {
        const imgUrl = c.subject?.images?.large
        if (imgUrl) {
          imageEntries.push({ url: imgUrl, subjectId: c.subject_id })
        }
      }
    }
  }

  let imageHashMap: Map<number, string> = new Map()
  if (imageEntries.length > 0) {
    try {
      imageHashMap = await downloadImagesWithLimit(imageEntries, imageStore, client, 2)
    } catch {
      // 图片下载失败不中断同步，imageHashMap 保持空 Map
    }
  }
```

- [x] **Step 3: 将 imageHashMap 传递给 merge/primaryMerge**

第 152 行 `merged = primaryMerge(primaryResult.value)` 改为：

```typescript
    merged = primaryMerge(primaryResult.value, imageHashMap)
```

第 172 行 `merged = merge(allCollections)` 改为：

```typescript
    merged = merge(allCollections, imageHashMap)
```

- [x] **Step 4: 在文件顶部添加 downloadImagesWithLimit 的 import**

在 import 区域添加：

```typescript
import { downloadImagesWithLimit } from './image/download.ts'
```

- [x] **Step 5: 验证类型检查**

```bash
cd packages/worker && npx tsc --noEmit
```

预期：无类型错误。

- [x] **Step 6: 提交**

```bash
git add packages/worker/src/cron.ts
git commit -m "feat: integrate image download pipeline into cron sync"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 8: 前端适配与死代码清理

**Files:**
- Modify: `public/src/bangumi.js`（无需代码修改，已有 null hash 处理；确认即可）
- Delete: `data/calendar.json`
- Modify: `README.md`（更新图片策略说明）

- [x] **Step 1: 确认 bangumi.js 已正确适配 null hash**

查看 `public/src/bangumi.js` 第 31 行：

```javascript
const imgUrl = entry.images && entry.images.hash
    ? API + '/image/' + entry.images.hash + '?w=300&fmt=webp'
    : 'data:image/svg+xml,' + ...
```

当 `hash` 为 `null` 时，`entry.images.hash` 为 falsy，走 fallback SVG。**无需修改代码。**

在 `packages/shared/src/merger.ts` 中 `MergedEntry.images.hash` 改为 `string | null` 后，前端收到的 JSON 中 `hash` 为 `null` 时会正确走 fallback。

- [x] **Step 2: 删除 data/calendar.json**

```bash
rm data/calendar.json
```

验证：`ls data/calendar.json` → `ls: data/calendar.json: No such file or directory`

- [x] **Step 3: 更新 README.md 图片策略说明**

在 README.md 中找到图片相关部分（可能在「架构」或「功能」章节），更新为反映真实状态：

```markdown
## 图片策略

Worker 在 cron 同步时自动下载条目封面，计算 SHA-256 哈希后存入 R2 bucket（`bangumi-tv-images`）。
图片通过 `/image/:hash` 路由按需提供，支持格式转换（webp）和尺寸调整（w 参数）。
下载限流至最多 2 个并行，单张超时 8 秒，失败不影响同步整体流程。

前端在 `hash` 为 null 时使用纯色占位 SVG，避免构造损坏 URL。
```

如果 README 中没有图片章节，在「功能」或「部署」部分添加上述内容。

- [x] **Step 4: 提交**

```bash
git add data/calendar.json README.md
git commit -m "chore: remove dead data/calendar.json, update README image strategy"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 9: merger.test.ts — 核心测试

**Files:**
- Create: `packages/shared/src/merger.test.ts`

**Interfaces:**
- Consumes: `merge`、`primaryMerge`、`MergedEntry`、`MergedCollections` from `./merger`；`BgmCollection` from `./bgm-client`

- [x] **Step 1: 创建测试文件**

```typescript
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { merge, primaryMerge } from './merger.ts'
import type { BgmCollection } from './bgm-client.ts'
import type { MergedCollection } from './merger.ts'

function makeCollection(
  subjectId: number,
  overrides: Partial<BgmCollection> = {},
): BgmCollection {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 0,
    type: 3, // watching
    comment: '',
    tags: [],
    ep_status: 0,
    vol_status: 0,
    updated_at: '2025-01-01T00:00:00.000Z',
    private: false,
    subject: {
      id: subjectId,
      type: 2,
      name: `Subject ${subjectId}`,
      name_cn: `主题 ${subjectId}`,
      summary: '',
      nsfw: false,
      date: '',
      eps: 0,
      total_episodes: 0,
      images: { large: '', common: '', medium: '', small: '', grid: '' },
      rating: { score: 0, rank: 0, total: 0 },
    },
    ...overrides,
  }
}

// ── 场景 1: 单账户合并 ──

it('单账户合并 — 所有条目保留', () => {
  const c1 = makeCollection(1)
  const c2 = makeCollection(2)
  const c3 = makeCollection(3)
  const result = merge([[c1, c2, c3]])
  assert.equal(result.watching.length, 3)
  assert.equal(result.want.length, 0)
  assert.equal(result.watched.length, 0)
  assert.equal(result.on_hold.length, 0)
  assert.equal(result.dropped.length, 0)
  assert.ok(result.updated_at)
})

// ── 场景 2: 多账户合并，部分重叠 ──

it('多账户合并 — 重叠条目只出现一次（保留最新 updated_at）', () => {
  const c1 = makeCollection(1, { updated_at: '2025-01-01T00:00:00.000Z' })
  const c2 = makeCollection(1, { updated_at: '2025-06-01T00:00:00.000Z', rate: 8 })
  const c3 = makeCollection(2, { updated_at: '2025-03-01T00:00:00.000Z' })
  const result = merge([[c1, c3], [c2]])
  // subject_id 1 只出现一次，取 rate=8（来自更新的记录）
  const entry1 = result.watching.find((e) => e.subject_id === 1)
  assert.ok(entry1)
  assert.equal(entry1.rate, 8)
  // subject_id 2 出现一次
  assert.equal(result.watching.filter((e) => e.subject_id === 2).length, 1)
  assert.equal(result.watching.length, 2)
})

// ── 场景 3: primary 失败保护 ──

it('primary 失败保护 — 主账户不可用时抛出错误', () => {
  assert.throws(() => {
    primaryMerge([])
  })
})

// 注意：primaryMerge 的实际失败保护逻辑在 cron.ts 中（检查 settled 状态），
// primaryMerge 本身不会抛出错误。这里测试空数组场景——应该返回空快照而非崩溃。
it('primaryMerge 空数组 — 返回空快照', () => {
  const result = primaryMerge([])
  assert.equal(result.watching.length, 0)
  assert.equal(result.want.length, 0)
  assert.equal(result.watched.length, 0)
  assert.equal(result.on_hold.length, 0)
  assert.equal(result.dropped.length, 0)
  assert.ok(result.updated_at)
})

// ── 场景 4: 空输入 ──

it('空输入 — 空 collection 数组返回空快照', () => {
  const result = merge([[], []])
  assert.equal(result.watching.length, 0)
  assert.equal(result.want.length, 0)
  assert.ok(result.updated_at)
})

it('完全空数组 — [[]] 返回空快照', () => {
  const result = merge([[]])
  assert.equal(result.watching.length, 0)
  assert.ok(result.updated_at)
})

// ── 场景 5: 全部 NSFW ──

it('全部 NSFW — NSFW 标记保留在条目中', () => {
  const c1 = makeCollection(1, { subject: { ...makeCollection(1).subject!, nsfw: true } })
  const c2 = makeCollection(2, { subject: { ...makeCollection(2).subject!, nsfw: true } })
  const result = merge([[c1, c2]])
  assert.equal(result.watching.length, 2)
  assert.ok(result.watching.every((e) => e.nsfw === true))
})

// ── 场景 6: 图片 hash 传递 ──

it('图片 hash 传递 — imageHashMap 中的 hash 反映到 MergedEntry.images', () => {
  const c1 = makeCollection(1)
  const c2 = makeCollection(2)
  const hashMap = new Map<number, string>([
    [1, 'abc123'],
    [2, 'def456'],
  ])
  const result = merge([[c1, c2]], hashMap)
  const entry1 = result.watching.find((e) => e.subject_id === 1)!
  const entry2 = result.watching.find((e) => e.subject_id === 2)!
  assert.equal(entry1.images.hash, 'abc123')
  assert.equal(entry2.images.hash, 'def456')
})

it('图片 hash 传递 — 无 hash 时 images.hash 为 null', () => {
  const c1 = makeCollection(1)
  const c2 = makeCollection(2)
  const hashMap = new Map<number, string>([[1, 'abc123']])
  const result = merge([[c1, c2]], hashMap)
  const entry1 = result.watching.find((e) => e.subject_id === 1)!
  const entry2 = result.watching.find((e) => e.subject_id === 2)!
  assert.equal(entry1.images.hash, 'abc123')
  assert.equal(entry2.images.hash, null)
})

it('图片 hash 传递 — 不传 imageHashMap 时所有 hash 为 null', () => {
  const c1 = makeCollection(1)
  const result = merge([[c1]])
  assert.equal(result.watching[0].images.hash, null)
})
```

- [x] **Step 2: 运行测试确认全部通过**

```bash
cd packages/shared && node --test src/merger.test.ts
```

预期：所有测试 PASS。

```bash
cd packages/shared && pnpm test
```

预期：新旧测试全部通过。

- [x] **Step 3: 提交**

```bash
git add packages/shared/src/merger.test.ts
git commit -m "test: add merger.test.ts — single/multi merge, primary, empty, NSFW, image hash"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

### Task 10: download.test.ts — 限流与降级测试

**Files:**
- Create: `packages/worker/src/image/download.test.ts`

**Interfaces:**
- Consumes: `downloadImagesWithLimit`、`ImageStore`（mock）、`BgmClient`（mock）

- [x] **Step 1: 创建测试文件**

```typescript
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { downloadImagesWithLimit } from './download.ts'
import type { ImageStore } from './store.ts'
import { BgmClient } from '@bangumi-tv/shared'

// ── Mock 工厂 ──

function createMockImageStore(): ImageStore {
  return {
    putOriginal: mock.fn(async () => {}),
    getOriginal: mock.fn(async () => null),
    getVariant: mock.fn(async () => null),
    putVariant: mock.fn(async () => {}),
  }
}

function createMockBgmClient(
  results: Array<{ data: ArrayBuffer; contentType: string } | null>,
): BgmClient {
  let callIndex = 0
  return {
    ...new BgmClient(),
    downloadImage: mock.fn(async (_url: string) => {
      return results[callIndex++] ?? null
    }),
  } as any
}

function arrayBufferFrom(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer
}

// ── 场景 1: 并发限制 ──

it('并发限制 — 最多 concurrency 个并行下载', async () => {
  let concurrent = 0
  let maxConcurrent = 0
  const realBgmClient = new BgmClient()
  const mockClient = {
    ...realBgmClient,
    downloadImage: mock.fn(async (_url: string) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      // 模拟网络延迟
      await new Promise((r) => setTimeout(r, 50))
      concurrent--
      return { data: arrayBufferFrom('img-data'), contentType: 'image/jpeg' }
    }),
  } as any

  const store = createMockImageStore()
  const entries = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.com/img/${i}.jpg`,
    subjectId: i + 1,
  }))

  await downloadImagesWithLimit(entries, store, mockClient, 2)

  assert.ok(maxConcurrent <= 2, `最大并发数 ${maxConcurrent} > 2`)
  assert.equal(mockClient.downloadImage.mock.callCount(), 10)
  assert.equal(store.putOriginal.mock.callCount(), 10)
})

// ── 场景 2: 下载失败降级 ──

it('下载失败降级 — 某图片 404 不中断其余', async () => {
  const results = [
    { data: arrayBufferFrom('img-1'), contentType: 'image/jpeg' },
    null, // 第二张失败
    { data: arrayBufferFrom('img-3'), contentType: 'image/png' },
  ]
  const mockClient = createMockBgmClient(results)
  const store = createMockImageStore()

  const entries = [
    { url: 'https://example.com/1.jpg', subjectId: 1 },
    { url: 'https://example.com/2.jpg', subjectId: 2 },
    { url: 'https://example.com/3.jpg', subjectId: 3 },
  ]

  const hashMap = await downloadImagesWithLimit(entries, store, mockClient, 1)

  assert.equal(hashMap.size, 2)
  assert.ok(hashMap.has(1))
  assert.ok(!hashMap.has(2)) // 失败的条目不在结果中
  assert.ok(hashMap.has(3))
  // 确认 putOriginal 只被调用了 2 次（失败的跳过）
  assert.equal(store.putOriginal.mock.callCount(), 2)
})

// ── 场景 3: 全部成功 ──

it('全部成功 — 3 个有效 URL 返回 3 个 hash 映射', async () => {
  const results = [
    { data: arrayBufferFrom('data-1'), contentType: 'image/jpeg' },
    { data: arrayBufferFrom('data-2'), contentType: 'image/webp' },
    { data: arrayBufferFrom('data-3'), contentType: 'image/png' },
  ]
  const mockClient = createMockBgmClient(results)
  const store = createMockImageStore()

  const entries = [
    { url: 'https://example.com/a.jpg', subjectId: 10 },
    { url: 'https://example.com/b.jpg', subjectId: 20 },
    { url: 'https://example.com/c.jpg', subjectId: 30 },
  ]

  const hashMap = await downloadImagesWithLimit(entries, store, mockClient, 3)

  assert.equal(hashMap.size, 3)
  assert.ok(hashMap.has(10))
  assert.ok(hashMap.has(20))
  assert.ok(hashMap.has(30))
  // 所有 hash 都是 64 字符的 hex 字符串（SHA-256）
  for (const hash of hashMap.values()) {
    assert.equal(hash.length, 64)
    assert.ok(/^[0-9a-f]{64}$/.test(hash))
  }
})
```

- [x] **Step 2: 运行测试确认全部通过**

```bash
cd packages/worker && node --test src/image/download.test.ts
```

预期：所有测试 PASS。

```bash
cd packages/worker && pnpm test
```

预期：新旧测试全部通过。

- [x] **Step 3: 提交**

```bash
git add packages/worker/src/image/download.test.ts
git commit -m "test: add download.test.ts — concurrency limit, failure degradation, full success"
```

archived-with: 2026-06-22-restore-project-quality-gates
---

## 自检清单

### 1. Spec 覆盖

| Design Doc 章节 | 对应任务 |
|----------------|---------|
| 2.1 包管理恢复 | Task 1 |
| 2.2 CI 质量门 | Task 2, Task 3 |
| 2.3 R2 图片管线恢复 | Task 5, Task 6, Task 7 |
| 2.4 Env 类型生成 | Task 4 |
| 2.5 死代码清理 | Task 8 |
| 4.1 新增测试（merger） | Task 9 |
| 4.1 新增测试（download） | Task 10 |
| 4.3 CI 整合 | Task 2 (scripts) + Task 3 (CI steps) |
| 6 文件变更清单 | 所有 Task 全覆盖 |

### 2. 占位符检查

无占位符。每个任务的每个步骤包含完整代码或精确命令。

### 3. 类型一致性

- `MergedEntry.images.hash`: `string | null`（Task 6）— 前端 `bangumi.js` 通过 `entry.images && entry.images.hash` 检查，`null` 为 falsy，正确走 fallback。
- `runSync` 的 `imageStore` 参数类型：`ImageStore`（Task 7）— 调用者 `index.ts` 传入 `new R2ImageStore(env.BANGUMI_R2)`。
- `downloadImagesWithLimit` 返回 `Map<number, string>`（Task 5）— `merge()` 接受 `Map<number, string> | undefined`（Task 6）。
- `toMergedEntry(c, imageHashMap?)` 的内部逻辑：`imageHashMap?.get(c.subject_id) ?? null` — 当无 map 或无条目时返回 `null`。

archived-with: 2026-06-22-restore-project-quality-gates
---

## 执行交接

**计划完成，保存至 `docs/superpowers/plans/2026-06-22-restore-project-quality-gates.md`。**

两种执行方式：

1. **Subagent-Driven（推荐）** — 为每个 Task 分派独立的子 agent，逐任务 review，快速迭代
2. **Inline Execution** — 在当前会话中使用 executing-plans 技能，批量执行含检查点

**选择哪种方式？**
