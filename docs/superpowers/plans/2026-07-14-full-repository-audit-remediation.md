---
change: remediate-full-repository-audit
design-doc: docs/superpowers/specs/2026-07-14-full-repository-audit-remediation-design.md
base-ref: 549edf34af2d860ccc995de589631242d4a24e2d
---

# 全仓审计剩余问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完整修复剩余的公开界面 XSS/Token 风险、Read API 契约、bgm.tv 章节同步、subject 404 tombstone 与 Widget 资产漂移问题。

**Architecture:** 保持现有 Worker 与包边界，在 Widget 内集中输出编码和 URL 校验，在 Read Worker 内集中严格参数解析，在 bgm client/platform 内实现完整分页和有界写入，在 Media 的 subject 串行刷新路径内实现 24 小时 tombstone。每个风险边界独立 RED→GREEN、审查、提交和推送，最后执行全量门禁与生产验收。

**Tech Stack:** TypeScript、Cloudflare Workers、KV/R2、Node test runner via `tsx --test`、pnpm workspace、OpenSpec/Comet。

## Global Constraints

- OpenSpec delta specs 是行为验收的唯一事实源；Design Doc 只规定实现结构。
- 修改任何 bgm.tv API 交互前必须核对 `docs/example/api/bgm-api.json` 中真实 path、method、query、auth 与 payload。
- Token 只能存在当前页面内存；初始化删除历史 `sync-tokenA`、`sync-tokenB`。
- not-found tombstone TTL 固定 `86400` 秒；网络、429、5xx 不得写 tombstone。
- 保持公开 endpoint 路径与 Cloudflare Free Plan，不引入新数据库或依赖。
- 每个任务必须先得到 RED 证据，再实现 GREEN；任务验收、审查、更新 `tasks.md` 后立即 commit/push。
- 实现影响公开契约时，同一任务同步 README；不得写尚未实现的前瞻文档。

## 文件职责映射

- `packages/widget/assets/theme/bangumi.js`：Widget 唯一手写交互与渲染源码。
- `packages/widget/assets/theme/cache.js`：页脚运行状态安全渲染源码。
- `packages/widget/src/generated-assets.ts`：由脚本生成的唯一部署资产产物。
- `packages/widget/src/render.test.ts`：Widget 生成资产、XSS、Token 和事件绑定契约测试。
- `apps/frontend-worker/src/index.ts`：公开 HTML/JS/CSS 与内部 Worker 路由、安全响应头。
- `apps/sync-worker/src/index.ts`：compare/apply/check HTTP 错误映射与 operation HTML。
- `apps/read-worker/src/index.ts`：严格 query parser、collections/cache/health 响应。
- `packages/bgm-api/src/bgm-client.ts`：bgm.tv 章节 GET/PATCH 原语。
- `packages/bgm-api/src/platform.ts`：章节差异、100 ID 分批与部分失败汇总。
- `apps/media-worker/src/index.ts`：subject refresh、404 tombstone 和暂时性错误语义。
- `packages/domain/src/subject-meta.ts`、`packages/storage/src/keys.ts`：若现有类型/键 helper 需要扩展，只承载共享 tombstone 类型和存储命名。
- `scripts/generate-widget-assets.mjs`：唯一资产生成器；build check 校验产物与旧目录不存在。

---

### Task 1: Widget 输出编码、URL 校验与无 inline handler

**Files:**
- Modify: `packages/widget/assets/theme/bangumi.js`
- Modify: `packages/widget/assets/theme/cache.js`
- Modify: `packages/widget/src/render.test.ts`
- Regenerate: `packages/widget/src/generated-assets.ts`

**Interfaces:**
- Produces: `escapeHtml(value): string`、`escapeAttribute(value): string`、`safeUrl(value, fallback): string`，以及仅通过 `addEventListener` 绑定的交互。
- Consumes: API 返回的标题、用户名、weekday、错误、图片 URL、operation link 和数值/枚举字段。

- [ ] **Step 1: 写 Widget 恶意输入与 inline handler 的失败测试**

在 `render.test.ts` 增加表驱动断言，至少覆盖：

```ts
for (const payload of ['<img src=x onerror=alert(1)>', '\" onmouseover=alert(1) x=\"', '</pre><script>alert(1)</script>']) {
  assert.doesNotMatch(renderUnsafeFixture(payload), /<script|onerror=|onmouseover=/i)
}
assert.doesNotMatch(widgetJs, /\sonclick\s*=/i)
assert.doesNotMatch(widgetJs, /\.onclick\s*=/)
assert.match(widgetJs, /addEventListener\(['"]click['"]/)
assert.doesNotMatch(renderUrlFixture('javascript:alert(1)'), /(?:href|src)=["']javascript:/i)
```

测试 helper 应执行或抽取真实模板路径，不能只测试一个与生产代码无关的复制函数；危险 URL 用 `javascript:alert(1)` 并断言不会进入 `href`/`src`。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `CI=true pnpm -F @airing-cal/widget test`

Expected: FAIL，至少指出现有 inline `onclick`/`.onclick` 或恶意 payload 未编码。

- [ ] **Step 3: 实现最小安全渲染边界**

在主题源码集中加入纯 helper，并逐个替换动态插值：

```js
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, function (char) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  })
}

function safeUrl(value, fallback) {
  try {
    var url = new URL(String(value), location.origin)
    if (url.origin === location.origin || url.protocol === 'https:' || url.protocol === 'http:') return url.href
  } catch (_) {}
  return fallback || '#'
}
```

静态按钮使用 `createElement`/`textContent`；批量卡片模板只插入编码文本、验证后的数字/枚举和 `safeUrl` 返回值。用 delegated `addEventListener` 替代 NSFW overlay 与分页的 inline/属性事件。

- [ ] **Step 4: 重新生成资产并验证 GREEN**

Run: `pnpm -F @airing-cal/widget generate`

Run: `CI=true pnpm -F @airing-cal/widget test && CI=true pnpm -F @airing-cal/widget typecheck`

Expected: PASS；`generated-assets.ts` 与主题源码同步。

- [ ] **Step 5: 审查、更新任务状态并原子提交推送**

检查所有 `innerHTML` 插值都有上下文处理，勾选 OpenSpec tasks `1.1`、`1.2` 中完成项。

```bash
git add packages/widget/assets/theme/bangumi.js packages/widget/assets/theme/cache.js packages/widget/src/generated-assets.ts packages/widget/src/render.test.ts openspec/changes/remediate-full-repository-audit/tasks.md
git commit -m "fix: eliminate widget output injection"
git push
```

### Task 2: Token 内存生命周期与公开 HTML 安全头

**Files:**
- Modify: `packages/widget/assets/theme/bangumi.js`
- Modify: `packages/widget/src/render.test.ts`
- Regenerate: `packages/widget/src/generated-assets.ts`
- Modify: `apps/frontend-worker/src/index.ts`
- Modify: `apps/frontend-worker/src/frontend-worker.test.ts`
- Modify: `apps/sync-worker/src/index.ts`
- Modify: `apps/sync-worker/src/sync-worker.test.ts`

**Interfaces:**
- Produces: 页面闭包内 `syncTokens = { A: '', B: '' }`；HTML header helper；`escapeHtml` 后的 operation `<pre>`。
- Preserves: operation JSON `{ ok: true, operation }` 契约。

- [ ] **Step 1: 写 Token、operation payload 与 header RED 测试**

```ts
assert.match(widgetJs, /removeItem\(['"]sync-tokenA['"]\)/)
assert.match(widgetJs, /removeItem\(['"]sync-tokenB['"]\)/)
assert.doesNotMatch(widgetJs, /(?:getItem|setItem)\(['"]sync-token[AB]['"]/)
assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
assert.match(html.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
assert.match(html.headers.get('content-security-policy') ?? '', /base-uri 'none'/)
assert.doesNotMatch(await html.text(), /<\/pre><script>/)
assert.deepEqual(await jsonResponse.json(), { ok: true, operation: maliciousOperation })
```

- [ ] **Step 2: 运行受影响测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/widget test && CI=true pnpm -F @airing-cal/frontend-worker test && CI=true pnpm -F @airing-cal/sync-worker test`

Expected: FAIL 于 sessionStorage 持久化、安全头或 operation HTML 注入断言。

- [ ] **Step 3: 实现内存 Token 与 HTML 安全策略**

页面初始化执行两次 `sessionStorage.removeItem`，输入/提交只读写闭包状态。Frontend 的 HTML 响应设置 CSP、nosniff、`X-Frame-Options: DENY`；operation HTML 使用：

```ts
const escaped = JSON.stringify(operation, null, 2)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
return new Response(`<h1>同步操作日志</h1><pre>${escaped}</pre>`, {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  },
})
```

- [ ] **Step 4: 生成资产并验证 GREEN**

Run: `pnpm -F @airing-cal/widget generate`

Run: `CI=true pnpm -F @airing-cal/widget test && CI=true pnpm -F @airing-cal/frontend-worker test && CI=true pnpm -F @airing-cal/sync-worker test`

Expected: PASS，JSON operation 测试保持不变。

- [ ] **Step 5: 提交推送**

勾选 tasks `1.3`、`1.4`。

```bash
git add packages/widget apps/frontend-worker/src apps/sync-worker/src openspec/changes/remediate-full-repository-audit/tasks.md
git commit -m "fix: confine tokens and harden public html"
git push
```

### Task 3: Read health/cache 严格契约

**Files:**
- Modify: `apps/read-worker/src/index.ts`
- Modify: `apps/read-worker/src/read-worker.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `parseCollectionType(value): type`、`parsePositiveInteger(name, value, fallback, max?): number`、`parseCursor(value): string | undefined`；非法输入抛出 `InvalidQueryError` 并映射 400。
- Changes: `/cache.total_subjects` → `/cache.page_subjects`；合法 cursor 字符串保持透传。

- [ ] **Step 1: 增加零收藏、严格参数与分页字段 RED 测试**

```ts
assert.equal((await health.json()).data.collections.types._total, 0)
assert.equal((await health.json()).data.cache.total_subjects, 0)
for (const query of ['page=2junk', 'page=0', 'limit=101', 'type=unknown', 'cursor=%00bad']) {
  assert.equal((await worker.fetch(new Request(`https://read.local/collections?${query}`), env)).status, 400)
}
assert.equal(cacheBody.page_subjects, cacheBody.items.length)
assert.equal('total_subjects' in cacheBody, false)
```

分别对 `/collections` 的 type/page/limit 与 `/cache` 的 limit/cursor 使用实际路由测试。

- [ ] **Step 2: 运行 Read Worker 测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/read-worker test`

Expected: FAIL，现有 `parseInt` 接受尾随字符、未知 type 默认 watching、零收藏 data 为 null、cache 字段仍为 `total_subjects`。

- [ ] **Step 3: 实现严格 parser 与完整 health**

```ts
class InvalidQueryError extends Error {}
function parsePositiveInteger(name: string, value: string | null, fallback: number, max?: number): number {
  if (value === null) return fallback
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidQueryError(`Invalid ${name}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || max !== undefined && parsed > max) throw new InvalidQueryError(`Invalid ${name}`)
  return parsed
}
```

cursor 允许现有 KV cursor 可表示字符但拒绝空串、控制字符和异常长度；catch `InvalidQueryError` 返回 400 稳定错误对象。health 始终组装 `data`，用 `types?._total ?? 0`。cache 返回 `page_subjects: entries.length`。

- [ ] **Step 4: 同步 README 并验证 GREEN**

README 明确 `page_subjects` breaking 字段与非法 query 的 400 行为。

Run: `CI=true pnpm -F @airing-cal/read-worker test && CI=true pnpm -F @airing-cal/read-worker typecheck && pnpm -F @airing-cal/read-worker build:check`

Expected: PASS。

- [ ] **Step 5: 提交推送**

勾选 tasks `2.1`～`2.3`。

```bash
git add apps/read-worker/src README.md openspec/changes/remediate-full-repository-audit/tasks.md
git commit -m "fix: enforce strict read api contracts"
git push
```

### Task 4: bgm.tv 章节完整分页与 100 ID 分批

**Files:**
- Modify: `packages/bgm-api/src/bgm-client.ts`
- Modify: `packages/bgm-api/src/bgm-client.test.ts`
- Modify: `packages/bgm-api/src/platform.ts`
- Modify: `packages/bgm-api/src/platform.test.ts`
- Modify: domain result types at the actual `PatchEntryResult` declaration found via `rg -n "interface PatchEntryResult|type PatchEntryResult" packages/domain`

**Interfaces:**
- Produces: `getSubjectEpisodeCollections(...): Promise<{data; total}>` 完整集合；每次 PATCH `episodeIds.length <= 100`。
- Produces: `BgmEpisodePatchError`，包含 `code: 'EPISODE_PATCH_PARTIAL'`、`succeeded: number`、`failedBatch: { index: number; episodeIds: number[] }` 与原始 cause，供 Sync Worker 映射为 partial/error 响应。

- [ ] **Step 1: 按规则核对本地 OpenAPI fixture**

Run: `sed -n '1994,2176p' docs/example/api/bgm-api.json`

Expected: 确认 GET/PATCH `/v0/users/-/collections/{subject_id}/episodes`、Bearer auth、`limit`/`offset` 和 PATCH body 的 `episode_id`/`type`。若 fixture 与计划示例不符，以 fixture 为准并先修订本任务。

- [ ] **Step 2: 写 1001+ 分页、空页与第二批失败 RED 测试**

构造第一页 1000、第二页 1，并断言请求 offsets `[0, 1000]`；构造 `total=1001` 但第二页为空，断言 rejection 含稳定 pagination code/message。对 201 个同 type ID 断言 PATCH sizes `[100, 100, 1]`；第二批返回 500 时断言结果不是完整成功且包含第一批成功与第二批失败。

- [ ] **Step 3: 运行 bgm-api 测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/bgm-api test`

Expected: FAIL，现实现只请求 offset 0 且按 type 一次发送全部 IDs。

- [ ] **Step 4: 实现分页、空页保护与批次汇总**

```ts
const data: BgmEpisodeCollection[] = []
let offset = 0
let total = 0
do {
  const page = await this.fetchJson<{ data: BgmEpisodeCollection[]; total: number }>(`${url}?limit=1000&offset=${offset}`, init)
  total = page.total
  if (data.length < total && page.data.length === 0) throw new BgmPaginationError(subjectId, offset, total)
  data.push(...page.data)
  offset += page.data.length
} while (data.length < total)
return { data, total }
```

Platform 以 `ids.slice(index, index + 100)` 分批；catch 时抛出 `BgmEpisodePatchError`，保留已成功数量和失败批次。Sync Worker 将该错误稳定序列化为非完整成功的 partial/error 响应且不得包含 Token。

- [ ] **Step 5: 验证 GREEN 并提交推送**

Run: `CI=true pnpm -F @airing-cal/bgm-api test && CI=true pnpm -F @airing-cal/bgm-api typecheck`

勾选 tasks `3.1`～`3.3`。

```bash
git add packages/bgm-api/src packages/domain/src openspec/changes/remediate-full-repository-audit/tasks.md
git commit -m "fix: paginate and batch episode synchronization"
git push
```

### Task 5: Compare 认证失败稳定映射

**Files:**
- Modify: `apps/sync-worker/src/index.ts`
- Modify: `apps/sync-worker/src/sync-worker.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `BgmHttpError.status` 或平台层等价认证错误。
- Produces: compare 认证失败的非 200 响应与稳定 `AUTHENTICATION_FAILED` code；不回显 Token。

- [ ] **Step 1: 写单账户与双账户无效 Token RED 测试**

模拟 `/v0/me` 或收藏请求返回 401/403，分别断言：

```ts
assert.ok([401, 403].includes(response.status))
assert.equal(body.ok, false)
assert.equal(body.error.code, 'AUTHENTICATION_FAILED')
assert.doesNotMatch(JSON.stringify(body), /source-secret|target-secret/)
```

- [ ] **Step 2: 运行 sync-worker 测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/sync-worker test`

Expected: FAIL，现有 compare catch 把认证错误映射为 500 或成功空结果。

- [ ] **Step 3: 实现认证错误分类并同步文档**

增加纯 `syncErrorResponse(error)` 或等价 helper：Syntax/validation→400，401/403→对应非 200 与稳定 code，其余上游错误沿用现有映射。README 记录 compare 认证错误契约。

- [ ] **Step 4: 验证 GREEN 并提交推送**

Run: `CI=true pnpm -F @airing-cal/sync-worker test && CI=true pnpm -F @airing-cal/sync-worker typecheck && pnpm -F @airing-cal/sync-worker build:check`

勾选 task `3.4`。

```bash
git add apps/sync-worker/src README.md openspec/changes/remediate-full-repository-audit/tasks.md
git commit -m "fix: surface compare authentication failures"
git push
```

### Task 6: 24 小时 subject 404 tombstone

**Files:**
- Modify: `apps/media-worker/src/index.ts`
- Modify: `apps/media-worker/src/media-worker.test.ts`
- Modify: subject metadata helper/type located via `rg -n "subjectMetaFromNotFound|interface SubjectMeta|type SubjectMeta" packages/domain packages/storage`
- Modify: cached detail helper located via `rg -n "getCachedSubjectDetail|subjectDetailKey" packages/storage`
- Modify: `apps/read-worker/src/index.ts`
- Modify: `apps/read-worker/src/read-worker.test.ts`

**Interfaces:**
- Produces: tombstone `{ subject_id, exists: false, nsfw: true, reason: 'not_found', checked_at, expires_at }`，`expires_at = checked_at + 86400`。
- Preserves: transient stale-on-error 与 per-subject generation coordinator。

- [ ] **Step 1: 写旧 detail→404、TTL 抑制、到期重探测与 transient RED 测试**

使用可控 `Date.now`：预置 subject detail，第一次 404 后断言旧 detail 被删除/屏蔽且 metadata 保守；推进 23:59 断言无第二次上游请求；推进超过 24h 断言重新请求。对 network、429、500 断言没有 `reason: not_found` 写入且旧 detail 仍可 stale-on-error。

- [ ] **Step 2: 运行 media/read 测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/media-worker test && CI=true pnpm -F @airing-cal/read-worker test`

Expected: FAIL，现有 not-found reason/TTL/旧 detail 屏蔽不满足规格。

- [ ] **Step 3: 实现 tombstone helper 与刷新短路**

```ts
const SUBJECT_NOT_FOUND_TTL_SECONDS = 24 * 60 * 60
function activeNotFound(meta: SubjectMeta | null, now: number): boolean {
  return meta?.exists === false && meta.reason === 'not_found'
    && typeof meta.expires_at === 'number' && now < meta.expires_at
}
```

串行 `processJob` 内先读 meta；有效 tombstone 时不调用 bgm client。确认 404 时写 tombstone 并删除 detail key或让所有读取路径优先屏蔽。恢复成功覆盖 meta/detail。catch 中仅 `BgmHttpError(404)` 走 tombstone；network/429/5xx 继续 throw/stale。

- [ ] **Step 4: 验证 generation 与 GREEN**

Run: `CI=true pnpm -F @airing-cal/media-worker test && CI=true pnpm -F @airing-cal/read-worker test && CI=true pnpm -F @airing-cal/domain test && CI=true pnpm -F @airing-cal/storage test`

Expected: PASS，包括现有 `subject-refresh-coordinator` 新 generation 覆盖旧 generation 测试。

- [ ] **Step 5: 提交推送**

勾选 tasks `4.1`～`4.3`。

```bash
git add apps/media-worker/src apps/read-worker/src packages/domain/src packages/storage/src openspec/changes/remediate-full-repository-audit/tasks.md
git commit -m "fix: tombstone missing subjects for 24 hours"
git push
```

### Task 7: 删除漂移 Widget 副本并锁定生成链

**Files:**
- Delete: `packages/widget/assets/public/**`
- Delete: `packages/widget/assets/theme/v1/**`
- Modify: `scripts/generate-widget-assets.mjs`
- Create or Modify: `scripts/generate-widget-assets.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Preserves: `assets/theme/{bangumi.js,bangumi.css,cache.js}` → `src/generated-assets.ts`。
- Produces: build/test gate，旧目录存在或生成产物漂移时失败。

- [ ] **Step 1: 证明旧目录无消费者**

Run: `rg -n "assets/public|assets/theme/v1|theme/v1" --glob '!packages/widget/assets/public/**' --glob '!packages/widget/assets/theme/v1/**' .`

Expected: 没有部署/生成消费者；只有审计 spec/plan 提及。如存在消费者，先迁移到唯一链路再删除。

- [ ] **Step 2: 写旧目录和生成漂移 RED 测试**

```js
assert.equal(existsSync('packages/widget/assets/public'), false)
assert.equal(existsSync('packages/widget/assets/theme/v1'), false)
assert.equal(actualGenerated, expectedGeneratedFromTheme)
```

Run: `node --test scripts/generate-widget-assets.test.mjs`

Expected: FAIL，因为旧目录仍存在。

- [ ] **Step 3: 删除副本并完善生成检查**

使用 `git rm -r packages/widget/assets/public packages/widget/assets/theme/v1`。测试通过临时目录或纯 render helper 计算输出，不能覆盖工作树后再声称一致。README 说明唯一编辑源和 `pnpm -F @airing-cal/widget generate`。

- [ ] **Step 4: 验证 GREEN 并提交推送**

Run: `pnpm -F @airing-cal/widget generate && node --test scripts/generate-widget-assets.test.mjs && CI=true pnpm -F @airing-cal/widget test && CI=true pnpm build:check`

Expected: PASS，生成后 `git diff -- packages/widget/src/generated-assets.ts` 为空。

勾选 tasks `5.1`～`5.3`。

```bash
git add -A packages/widget scripts/generate-widget-assets.mjs scripts/generate-widget-assets.test.mjs README.md openspec/changes/remediate-full-repository-audit/tasks.md
git commit -m "chore: remove stale widget asset copies"
git push
```

### Task 8: 全量质量门禁、文档审计与生产验收准备

**Files:**
- Modify: `README.md`（仅修复全量审计发现的实际漂移）
- Modify: `openspec/changes/remediate-full-repository-audit/tasks.md`
- Create during verify phase: verification report at the path required by `comet-verify`

**Interfaces:**
- Consumes: Tasks 1～7 的全部行为。
- Produces: clean immutable commit、完整审查证据和可进入 Comet verify 的状态。

- [ ] **Step 1: 执行 README 全量同步审计**

逐一核对公开路由、环境变量、Worker 职责、日志事件、Widget 生成链、400/认证/partial/tombstone 契约。仅修改与当前实现不一致的内容。

- [ ] **Step 2: 运行全量自动门禁**

Run: `CI=true pnpm test`

Run: `CI=true pnpm typecheck`

Run: `CI=true pnpm build:check`

Run: `./node_modules/.bin/openspec validate remediate-full-repository-audit --strict`

Run: `git diff --check`

Run: `pnpm audit --prod`

Expected: 全部 exit 0；任何失败先按 `systematic-debugging` 定位根因，不得直接猜修。

- [ ] **Step 3: 执行 thorough code review**

按安全边界、Read 契约、bgm API、Media 缓存和资产链分批 review，再做一次全量 review。P0/P1/P2 全部修复；接受的非 critical 发现必须在 tasks 或验证报告中记录原因和影响。

- [ ] **Step 4: 完成 build 阶段任务状态并提交推送**

勾选 tasks `6.1`～`6.3`；`6.4`、`6.5` 保留给 verify/PR/archive 阶段。

```bash
git add README.md openspec/changes/remediate-full-repository-audit/tasks.md
git commit -m "test: verify full audit remediation"
git push
```

- **Comet verify 后续：执行生产验收（不属于 build checkbox）**

用已进入 `dev` 历史的实际完整 SHA 部署；验证 CSP/nosniff/frame/base/noopener、恶意 payload 不可执行、零收藏 health、cache `page_subjects` 与 400、compare 认证错误、tombstone 24h 元数据、footer SHA。不得在 build 阶段提前宣称生产通过。

- **Comet verify/archive 后续：PR、合并与归档（不属于 build checkbox）**

生产验证与 GitHub checks 通过后勾选 `6.4`、`6.5`，创建 PR、等待检查、合并；用户确认后运行 Comet archive 并再次 strict validate。
