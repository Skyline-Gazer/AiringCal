---
comet_change: restore-project-quality-gates
role: technical-design
canonical_spec: openspec
archived-with: 2026-06-22-restore-project-quality-gates
status: final
---

# Design Doc: restore-project-quality-gates

- Status: draft
- Date: 2026-06-22

## 1. 架构概览

项目为 pnpm workspace 单仓库，含两个包：

```
packages/shared/   → 数据模型 + bgm.tv API 客户端（纯 TS 库）
packages/worker/   → Cloudflare Worker（Hono 路由 + cron 同步 + 管理后台）
```

Worker 通过 KV、R2、Durable Object 三种绑定访问 Cloudflare 基础设施。前端资产内联到 Worker bundle 中（无独立 Pages 项目）。

本 change 在三个维度修复质量：
- **包管理**：固定工具链，消除双 lockfile 漂移
- **CI 门禁**：在部署前强制 typecheck → test → build:check
- **架构完整性**：恢复 R2 图片管线（死代码 → 端到端可运行）

## 2. 组件设计

### 2.1 包管理恢复

**当前问题**：`package-lock.json`（npm）与 `pnpm-lock.yaml`（pnpm）并存，`.gitignore` 忽略了 pnpm lockfile，CI 无 `--frozen-lockfile`。

**修复步骤**：
1. 根 `package.json` 添加 `"packageManager": "pnpm@9.15.9"`（锁定到 CI 当前使用的版本）
2. 删除 `package-lock.json`
3. `.gitignore`：移除 `pnpm-lock.yaml`，添加 `package-lock.json`
4. CI：`pnpm install` → `pnpm install --frozen-lockfile`
5. CI：`pnpm/action-setup@v4` 的 `version: latest` → `version: 9.15.9`

### 2.2 CI 质量门

**新增三个检查步骤**（部署前依次执行）：

```yaml
- name: TypeCheck
  run: pnpm typecheck
- name: Test
  run: pnpm test
- name: Build Check
  run: pnpm run build:check
```

对应的 `package.json` scripts：

| 脚本 | `packages/shared` | `packages/worker` |
|------|-------------------|-------------------|
| `typecheck` | `tsc --noEmit` | `tsc --noEmit` |
| `test` | `node --test` | `node --test` |
| `build:check` | (无，纯库) | `wrangler deploy --dry-run --outdir dist` |

根 `package.json` 添加 `typecheck`、`test`、`build:check` 通过 pnpm `-r`（递归）运行所有包。

### 2.3 R2 图片管线恢复

**当前链路断裂点**：cron.ts 的 `runSync()` 接受 `_imageStore` 参数但从不使用 → 图片从未写入 R2。

**目标链路**：

```
cron.ts: runSync()
  ↓ 获取条目后
  ↓ 限流器控制并发（最多 N 个并行下载）
  ↓
bgm-client.downloadImage(url) → ArrayBuffer
  ↓ 计算 SHA-256 → hash
  ↓
R2ImageStore.putOriginal(hash, bytes, contentType)
  ↓
R2 bucket ("bangumi-tv-images")
  ↓ 已有路由 `GET /image/:hash` → image/proxy.ts
  ↓ 已有处理：格式转换（webp）、尺寸调整（w）、缓存头
  ↓
前端：<img src="/image/{hash}?w=300&fmt=webp">
```

**限流设计**（避免 Worker 子请求 CPU 超限）：

```ts
async function downloadImagesWithLimit(
  entries: Array<{ url: string; subjectId: number }>,
  imageStore: ImageStore,
  bgmClient: BgmClient,
  concurrency: number = 2  // 保守并发数
): Promise<Map<number, string>> {
  // 使用信号量模式：最多 concurrency 个并行 fetch
  // 每个图片下载超时 8s，失败不阻塞整体流程
  // 返回 subjectId → hash 映射
}
```

**merger.ts 修改**：`MergedEntry.images` 从空占位 `{ hash: '', w: 0, h: 0 }` 改为实际 hash：

```ts
// 修改前
images: { hash: '', w: 0, h: 0 }

// 修改后
images: { hash: imageHash ?? null, w: originalW, h: originalH }
// 无图片时 hash 为 null，前端降级处理（不渲染 img 标签或使用占位图）
```

**前端适配**（`public/src/bangumi.js`）：hash 为 null 时隐藏图片区，不再构造 `/image//?w=...` 这种损坏 URL。

### 2.4 Env 类型生成

**当前**：`interface Env` 在 `index.ts` 中手写（60-74 行）。

**修改为**：使用 `wrangler types` 生成 `worker-configuration.d.ts`：

```bash
cd packages/worker && npx wrangler types --env-interface Env worker-configuration.d.ts
```

生成的类型文件纳入版本管理。`interface Env` 从 `index.ts` 中删除，改为从 `worker-configuration.d.ts` import。

**注意事项**：
- 每次 `wrangler.toml` 修改后需重新运行 `wrangler types`
- CI 的 `build:check` / `wrangler deploy --dry-run` 会间接验证类型一致性
- 作为额外保障，可在 `typecheck` 前加一个 `wrangler types` 步骤确保类型最新

### 2.5 死代码清理

| 文件 | 操作 | 原因 |
|------|------|------|
| `data/calendar.json` | 删除 | Vercel 时代遗留，已被 KV 替代 |
| `merger.ts` images 空占位 | 改为可为 null 的真实 hash | 消除失真数据 |
| 前端 `bangumi.js` | 适配 null hash | 不再构造损坏 URL |

`image/store.ts` 和 `image/proxy.ts` **保留**——它们是 R2 管线的消费侧，现在有生产者了。

## 3. 数据流

### 3.1 同步与图片写入流程（修改后）

```
scheduled(env) [cron trigger 每4小时]
  → SyncLock 获取互斥锁
  → runSync(env.BANGUMI_KV, env.BANGUMI_R2, env.SYNCLOCK, ...)
    → fetchAllCollections() 从 bgm.tv 拉取所有账户数据
    → merge / primaryMerge 合并
    → downloadImagesWithLimit(entries, imageStore, bgmClient, concurrency=2)
      → 对每个有封面的条目：
        → bgmClient.downloadImage(url) → ArrayBuffer（超时 8s）
        → crypto.subtle.digest('SHA-256', bytes) → hex hash
        → imageStore.putOriginal(hash, bytes, contentType)
        → 失败静默跳过（不中断整体同步）
    → merger 将 hash 写入 MergedEntry.images
    → KV.put('collections', JSON.stringify(collections))
    → KV.put('calendar', JSON.stringify(calendarItems))
  → SyncLock 释放锁
```

### 3.2 图片服务流程（已有，不变）

```
GET /image/:hash  [image/proxy.ts]
  → 从 URL 解析 hash、w、fmt 参数
  → R2.get(`original/${hash}`)
    → 命中：检查格式/尺寸是否需要变换
      → 需要变换：用 Web API 变换 → 缓存到 R2 → 返回
      → 无需变换：直接返回原始
    → 未命中：404
  → Cache-Control: public, max-age=31536000, immutable
```

## 4. 测试策略

### 4.1 新增测试

**`packages/shared/src/merger.test.ts`**（核心）：

| 场景 | 输入 | 预期 |
|------|------|------|
| 单账户合并 | 1 个账户的 collection | 所有条目保留 |
| 多账户合并 | 2 个账户，部分重叠 | 重叠条目只出现一次 |
| primary 失败保护 | 主账户不可用 | 备份账户数据仍生成快照 |
| 空输入 | 空 collection 数组 | 空快照 |
| 全部 NSFW | 所有条目标记 NSFW | 非 NSFW 模式可见，NSFW 模式隐藏 |
| 图片 hash 传递 | 合并时传入 imageHashMap | MergedEntry.images 反映实际 hash |

**`packages/worker/src/image/download.test.ts`**（限流逻辑）：

| 场景 | 输入 | 预期 |
|------|------|------|
| 并发限制 | 10 个条目，concurrency=2 | 最多 2 个并行子请求 |
| 下载失败降级 | 某图片 404 | 该条目 hash=null，不中断其余 |
| 全部成功 | 3 个有效 URL | 返回 3 个 hash 映射 |

### 4.2 已有测试（不变）

7 个已有测试文件使用 `node:test`，路径不变，无需迁移。

### 4.3 CI 整合

```bash
# 根 package.json
"test": "pnpm -r test"

# 各包 package.json
"test": "node --test"
```

## 5. 风险与缓解

| 风险 | 可能性 | 影响 | 缓解 |
|------|--------|------|------|
| Worker 子请求 CPU 超限 | 中 | cron 同步失败 | 限流 semaphore（concurrency=2），单张超时 8s |
| bgm.tv 图片服务器限流 | 低 | 部分图片下载失败 | 失败即跳过，不设重试，hash=null |
| wrangler types 生成的声明不完整 | 低 | 类型检查可能漏过绑定错误 | `wrangler deploy --dry-run` 作为最终保障 |
| pnpm 版本锁定后 CI 不兼容 | 极低 | CI 无法运行 | `pnpm/action-setup@v4` 支持指定版本 |
| 删除 package-lock.json 后 npm 用户无法安装 | 极低 | npm 警告 | 移至 pnpm-only 是明确决策，README 已说明 pnpm |

## 6. 文件变更清单

| 操作 | 文件 |
|------|------|
| 修改 | `package.json`（根）：`packageManager` + scripts |
| 修改 | `packages/shared/package.json`：`typecheck`、`test` |
| 修改 | `packages/worker/package.json`：`typecheck`、`test`、`build:check` |
| 删除 | `package-lock.json` |
| 修改 | `.gitignore`：swap lockfile 规则 |
| 修改 | `.github/workflows/deploy.yml`：固定 pnpm 版本、添加质量检查步骤 |
| 新增 | `packages/shared/src/merger.test.ts` |
| 新增 | `packages/worker/src/image/download.test.ts` |
| 修改 | `packages/worker/src/cron.ts`：接入图片下载 |
| 修改 | `packages/shared/src/merger.ts`：images hash 从空占位改为真实值 |
| 修改 | `packages/worker/src/index.ts`：Env 类型改为从生成文件 import |
| 新增 | `packages/worker/worker-configuration.d.ts`：`wrangler types` 生成 |
| 修改 | `public/src/bangumi.js`：适配 null hash |
| 删除 | `data/calendar.json` |
| 修改 | `README.md`：更新图片策略说明 |
| 修改 | `design.md`：关闭 Open Questions |

## 7. Delta Spec 一致性

无 spec 变更需求。现有 delta spec（`specs/project-quality-gates/spec.md`）已完整覆盖本设计所做的所有决策，包括：
- 包管理器唯一
- 高风险逻辑自动检查
- 类型 & bundle 可验证
- 声明能力可运行
- CI 工具版本可复现
- 文档核对
