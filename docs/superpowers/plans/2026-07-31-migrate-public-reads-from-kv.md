---
change: migrate-public-reads-from-kv
design-doc: docs/superpowers/specs/2026-07-31-migrate-public-reads-from-kv-design.md
base-ref: 003da78af1fec87726460b6bd406f0c01b0deb91
---

# migrate-public-reads-from-kv Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 幂等导入 legacy 逐 subject 状态到 D1、每日 shadow 等价比较连续 7 次且 KV 预算达标后把公开读取从 legacy KV 切换到验证过的 R2 snapshot，并延迟限速清理旧 key。

**Architecture:** 迁移与 shadow 比较作为每日 D1 路径的新阶段；迁移期 pointer 写 `public:shadow-current`，门禁通过后提升为 `public:current` 并置 `public:read-mode=r2`；read-worker 验证 pointer 后读 R2 完整对象，fallback 顺序为 Cache API 最后验证版 → legacy KV manifest。

**Tech Stack:** TypeScript 6、Node test runner（`tsx --test`）、Cloudflare Workers/Workflows/Queues/KV/D1/R2、Wrangler 4、pnpm workspace。

## Global Constraints

- 遵守 `docs/rules/docs-sync.md`：写 CLI flag/config/API 前必须 `--help`/查类型/查源码；文档与代码同步；每个原子变更 commit and push。
- 严格 TDD：先观察预期失败再改生产代码；最小实现转绿后重构。
- 公开 HTTP URL、分页参数与响应 shape 不变；`/api/health` 只增字段不删字段。
- 每日 cron 保持 20:00 UTC；迁移期 live legacy 发布继续（保证公开新鲜），D1 shadow 阶段追加同日运行；迁移路径不得写 legacy 逐 subject KV。
- 迁移期 `public:current` 不被 shadow 写入；只有连续 7 次 shadow 一致且每日 KV 写预算 ≤100 才允许提升 pointer 并切换。
- 图片不重下不复制；R2 key 原样复用；D1 更新状态不被 legacy 覆盖。
- 无新 D1 表、无 migration SQL、无新 Cloudflare 资源。

## File Structure

- Create `packages/storage/src/legacy-migration-types.ts` — 迁移/shadow/read-mode/清理 typed app_state values 与 key builders。
- Create `packages/storage/src/legacy-migration.ts` — legacy KV 记录读取、批量导入、可恢复 runner 核心（纯逻辑，注入 store/KV）。
- Create `packages/storage/src/shadow-compare.ts` — legacy 公开结果构建、规范化、比较、streak 更新。
- Create `apps/sync-worker/src/migration-runner.ts` — 每日 shadow 路径内的迁移 step（游标 checkpoint + summary）。
- Create `apps/sync-worker/src/read-mode.ts` — 门禁判定、pointer 提升、read-mode 切换/回滚。
- Modify `apps/sync-worker/src/r2-publication.ts` — pointer key 可配置（shadow/public）。
- Create `apps/read-worker/src/r2-snapshot.ts` — pointer 验证、R2 加载、Cache API、legacy fallback。
- Modify `apps/read-worker/src/index.ts` — read-mode 分支 + health 扩展。
- Create `apps/sync-worker/src/legacy-cleanup.ts` — 14 天后限速清理 runner。
- Modify `apps/sync-worker/src/workflow-core.ts` / `apps/sync-worker/src/index.ts` — 每日 shadow 阶段接线。
- Tests：与每个模块同目录 `*.test.ts`；全仓门禁用 `CI=true pnpm test` / `pnpm typecheck` / `pnpm build:check`。

---

### Task 1: 迁移 typed state 与 key builders

**Files:**
- Create: `packages/storage/src/legacy-migration-types.ts`
- Create: `packages/storage/src/legacy-migration-types.test.ts`
- Modify: `packages/storage/src/index.ts`（re-export）

**Interfaces:**
- Consumes: 无。
- Produces: `MigrationCursorV1 { last_subject_id: number; batch_index: number; updated_at: number }`；`MigrationSummaryV1 { imported: number; skipped_existing: number; missing_keys: number; errored: number; updated_at: number }`；`ShadowStreakV1 { streak: number; last_success_at: number | null; last_diff_summary: string | null; updated_at: number }`；`ReadModeV1 { mode: 'legacy' | 'r2'; switched_at: number | null }`；`KvBudgetDailyV1 { date: string; legacy_subject_kv_writes: number; updated_at: number }`；`CleanupCursorV1 { last_subject_id: number | null; deleted_count: number; updated_at: number }`；key builders `migrateLegacyCursorKey()`、`migrateLegacySummaryKey()`、`migrateShadowStreakKey()`、`migrateReadModeKey()`、`migrateKvBudgetDailyKey()`、`migrateCleanupCursorKey()`、`publicReadModeKvKey()`。

- [x] **Step 1: 写失败测试**

`packages/storage/src/legacy-migration-types.test.ts`（node:test）：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  migrateLegacyCursorKey, migrateLegacySummaryKey, migrateShadowStreakKey,
  migrateReadModeKey, migrateKvBudgetDailyKey, migrateCleanupCursorKey,
  publicReadModeKvKey,
} from './legacy-migration-types.ts'

test('migration app_state keys are namespaced and stable', () => {
  assert.equal(migrateLegacyCursorKey(), 'migrate:legacy:cursor')
  assert.equal(migrateLegacySummaryKey(), 'migrate:legacy:summary')
  assert.equal(migrateShadowStreakKey(), 'migrate:shadow:streak')
  assert.equal(migrateReadModeKey(), 'migrate:read-mode')
  assert.equal(migrateKvBudgetDailyKey(), 'migrate:kv-budget-daily')
  assert.equal(migrateCleanupCursorKey(), 'migrate:cleanup:cursor')
  assert.equal(publicReadModeKvKey(), 'public:read-mode')
})
```

- [x] **Step 2: 运行确认失败**

`node --import tsx --test packages/storage/src/legacy-migration-types.test.ts`
预期：FAIL（模块不存在）。

- [x] **Step 3: 实现**

`legacy-migration-types.ts` 导出六个 `'migrate:*'` key 常量、`'public:read-mode'` 常量与五个 typed interfaces（字段如 Interfaces 所示）。

- [x] **Step 4: 转绿**

`node --import tsx --test packages/storage/src/legacy-migration-types.test.ts` → PASS；`packages/storage/src/index.ts` re-export 全部类型与 builders；`pnpm --filter @airing-cal/storage typecheck` PASS。

- [x] **Step 5: 提交**

`git commit -m "feat(storage): add migration typed state and key builders"`

---

### Task 2: legacy 记录读取与幂等批量导入

**Files:**
- Create: `packages/storage/src/legacy-migration.ts`
- Create: `packages/storage/src/legacy-migration.test.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Consumes: `SubjectMediaRow`、`subjectDetailKey`/`subjectMetaKey`/`imageStatusKey`/`subjectRefreshKey`（index.ts）、`D1StateStore` 的 `getSubjectMedia`/`upsertSubjectMedia`（按现有签名）。
- Produces: `LegacySubjectRecords { subject_id: number; detail?: unknown; meta?: unknown; imageStatus?: unknown; refresh?: unknown }`；`importLegacySubjectBatch(store, kv, subjectIds: number[]): Promise<MigrationSummaryV1>`；`readLegacySubjectRecords(kv, subjectId): Promise<LegacySubjectRecords>`。

- [x] **Step 1: 写失败测试**（`legacy-migration.test.ts`，用 RecordingKV + SqliteD1）：

```ts
test('import skips subjects with newer D1 state and reuses R2 keys without R2 puts', async () => {
  const store = d1WithMedia(1, { detail_json: '{"name":"newer"}', checked_at: 200 })
  const kv = kvWith({ 'subject:detail:1': { subject: { name: 'older' } } })
  const summary = await importLegacySubjectBatch(store, kv, [1])
  assert.equal(summary.imported, 0)
  assert.equal(summary.skipped_existing, 1)
  assert.equal(kv.r2Puts, 0)
})

test('missing legacy keys are counted and do not block later subjects', async () => {
  const store = d1WithoutMedia()
  const kv = kvWith({})
  const summary = await importLegacySubjectBatch(store, kv, [1, 2])
  assert.equal(summary.missing_keys, 2)
})
```

- [x] **Step 2: 运行确认失败** → FAIL（模块不存在）。
- [x] **Step 3: 实现**：`readLegacySubjectRecords` 并行读四键（缺键返回 undefined）；`importLegacySubjectBatch` 对每个 subject 仅当 D1 行缺失或 `checked_at` 为空且 legacy detail 为对象时 `upsertSubjectMedia`，R2 ref 取 `imageStatus.common.r2_key`/`large.r2_key`，detail 取 `detail.subject`，nsfw 取 `meta.nsfw`；不触发 R2 PUT。
- [x] **Step 4: 转绿**：测试 PASS；补「中断重跑不重复覆盖」「legacy 无效 JSON 计入 errored」两个测试并转绿。
- [x] **Step 5: 提交** `git commit -m "feat(storage): import legacy subject state idempotently"`

---

### Task 3: sync 迁移 runner（游标 checkpoint + summary）

**Files:**
- Create: `apps/sync-worker/src/migration-runner.ts`
- Create: `apps/sync-worker/src/migration-runner.test.ts`

**Interfaces:**
- Consumes: `listCollectionRows()`（去重 subject 升序）、`getAppState/putAppStateIfNewer`、`importLegacySubjectBatch`、Task 1 keys。
- Produces: `runLegacyMigration(env): Promise<MigrationSummaryV1>`——从游标开始逐批 ≤50，批后 `putAppStateIfNewer('migrate:legacy:cursor', cursor, now)` 单调推进；summary 累加写 `migrate:legacy:summary`；单批失败记录 errored 不抛（P0 收藏发布不受影响）。

- [x] **Step 1: 失败测试**：第三批中断后重跑从持久化游标继续（构造 120 subject，前两批后 store 模拟中断，断言第二次调用从 `last_subject_id` 继续且已导入 subject 不重复计数）。
- [x] **Step 2: 确认 FAIL**。
- [x] **Step 3: 实现**：`runLegacyMigration` 读 cursor → `listCollectionRows()` 去重排序 → 切片批量循环 → 每批 `importLegacySubjectBatch` + cursor 推进（version=now）；批量错误捕获记 errored。
- [x] **Step 4: 转绿** + 补「空集合零批」「批次错误不阻塞后续批次」测试。
- [x] **Step 5: 提交** `git commit -m "feat(sync): add resumable legacy migration runner"`

---

### Task 4: shadow 规范化比较

**Files:**
- Create: `packages/storage/src/shadow-compare.ts`
- Create: `packages/storage/src/shadow-compare.test.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Consumes: `PublicSnapshotV1`、legacy snapshot keys + hydration 输入（images/nsfw/eps）。
- Produces: `buildLegacyPublicResult(legacy: { collections: PublicCollectionItemV1[]; calendar: PublicCalendarDayV1[]; summary: PublicSnapshotSummaryV1 }, hydrated: Record<number, { images?: {common?,large?}; nsfw?: number; eps?: number; total_episodes?: number; rating?: number }>): NormalizedPublicResult`；`normalizePublicResult(input): NormalizedPublicResult`（五类按 subject_id 升序、calendar 按 weekday 与 item 稳定排序、剔除 published_at/generation/分页字段）；`compareShadowSnapshots(legacy, r2): { equal: boolean; diffs: string[] }`（diff 形如 `collections.watched[0].name: legacy=A vs r2=B`，最多 20 条）。

- [x] **Step 1: 失败测试**：仅 `published_at` 不同的两端 `equal=true`；一个业务字段差异 `equal=false` 且 streak 应重置；排序噪声（乱序 subject_id）不影响 equal；diff 不含 source_url 等敏感字段。
- [x] **Step 2: 确认 FAIL**。
- [x] **Step 3: 实现**（规范化 + 逐字段递归比较，稳定排序，剔除运行时键）。
- [x] **Step 4: 转绿** + 补「calendar weekday 差异」「summary 计数差异」测试。
- [x] **Step 5: 提交** `git commit -m "feat(storage): normalize and compare shadow public results"`

---

### Task 5: streak 持久化与切换门禁

**Files:**
- Create: `apps/sync-worker/src/read-mode.ts`
- Create: `apps/sync-worker/src/read-mode.test.ts`

**Interfaces:**
- Consumes: `compareShadowSnapshots`、`ShadowStreakV1`、`KvBudgetDailyV1`、`sync_budget` 查询。
- Produces: `updateShadowStreak(store, equal, diffSummary, now): Promise<ShadowStreakV1>`（一致 +1，业务差异归零并记 diff）；`recordDailyKvBudget(store, date, writes)`；`shadowGatePassed(store, date): Promise<boolean>`（streak≥7 且连续 7 日 `legacy_subject_kv_writes<=100` 且 media budget 未超 hard limit）。

- [x] **Step 1: 失败测试**：第六次差异后 streak 归零；7 次一致且预算达标返回 true；6 次一致返回 false；某日 KV 写 101 返回 false。
- [x] **Step 2: 确认 FAIL**。
- [x] **Step 3: 实现**：`updateShadowStreak` 用 `putAppStateIfNewer`；`shadowGatePassed` 读 streak + 最近 7 日预算 rows + `sync_budget` media 行。
- [x] **Step 4: 转绿** + 补「streak 仅时间差异不重置」测试。
- [x] **Step 5: 提交** `git commit -m "feat(sync): persist shadow streak and gate cutover"`

---

### Task 6: pointer 门控与提升

**Files:**
- Modify: `apps/sync-worker/src/r2-publication.ts`
- Create: `apps/sync-worker/src/r2-publication-pointer.test.ts`
- Modify: `apps/sync-worker/src/d1-sync.ts`（shadow 发布传 pointer key）

**Interfaces:**
- Produces: `POINTER_KEY_SHADOW = 'public:shadow-current'`；`publishPublicSnapshot` 增加 `pointerKey?: string`（默认 `public:current`）；`promoteShadowPointer(kv, store, now): Promise<{ promoted: boolean; generation: number }>`——读取 shadow pointer，验证 schema/hash/r2_key，写 `public:current`，再写 `public:read-mode=r2`。

- [x] **Step 1: 失败测试**：迁移期（`read-mode=legacy`）shadow 发布只写 `public:shadow-current`，`public:current` 不变；门禁通过后 `promoteShadowPointer` 写 `public:current` + `public:read-mode=r2` 且顺序为 pointer 最后。
- [x] **Step 2: 确认 FAIL**。
- [x] **Step 3: 实现**：r2-publication pointer key 参数化；d1-sync shadow 路径在 `read-mode` 非 r2 时用 shadow key；`promoteShadowPointer` 验证后写 pointer 再镜像 read-mode（KV 失败不抛，记录 degraded）。
- [x] **Step 4: 转绿** + 补「提升幂等：重复调用不重复写 pointer」测试。
- [x] **Step 5: 提交** `git commit -m "feat(sync): gate public pointer behind shadow gate"`

---

### Task 7: read-worker R2 加载与 fallback

**Files:**
- Create: `apps/read-worker/src/r2-snapshot.ts`
- Create: `apps/read-worker/src/r2-snapshot.test.ts`
- Modify: `apps/read-worker/src/index.ts`

**Interfaces:**
- Consumes: `PublicSnapshotPointerV1`、`PublicSnapshotV1`（domain）、R2/Cache API/KV。
- Produces: `validatePointer(value): PublicSnapshotPointerV1 | null`；`loadVerifiedSnapshot(env, cache, pointer): Promise<{ snapshot: PublicSnapshotV1; fromCache: boolean } | null>`；`readSnapshotSource(env, cache): Promise<{ mode: 'legacy' } | { mode: 'r2'; snapshot: PublicSnapshotV1 }>`——顺序：read-mode=r2 → 验证 `public:current` → R2 GET → Cache API；任何失败降级 cache → legacy KV manifest。

- [x] **Step 1: 失败测试**：未知 schema 拒绝并使用 fallback；R2 GET 失败但缓存存在返回缓存版本；缓存与 R2 均失败回 legacy；`/api/collections` 分页结果与现契约一致（type/page/limit/cursor）。
- [x] **Step 2: 确认 FAIL**。
- [x] **Step 3: 实现**：pointer 校验（schema=1、generation≥0、hash 64 hex、r2_key、published_at）；R2 GET `snapshots/v1/{generation}-{hash}.json` → `parsePublicSnapshotV1`；Cache API key `r2-snapshot:{hash}` 存完整对象 + 验证元数据；hydration 不再走 legacy 逐 subject KV。
- [x] **Step 4: 转绿** + 补「图片引用与 NSFW 直接来自 snapshot」测试。
- [x] **Step 5: 提交** `git commit -m "feat(read): load verified R2 snapshot with bounded fallback"`

---

### Task 8: read-mode 接线与 health 扩展

**Files:**
- Modify: `apps/read-worker/src/index.ts`
- Create: `apps/read-worker/src/health.test.ts`

**Interfaces:**
- Produces: handler 顶层按 `public:read-mode`（KV，Cache API 短缓存）选择 `readSnapshotSource`；`/api/health` 追加 `snapshot: { source, generation, r2_key, verified_at }`、`migration: { shadow_streak, cursor, imported, skipped, missing_keys, kv_budget_ok, read_mode }`、`budget: { media: { reserved, consumed, soft_limit, hard_limit } }`（从 D1 读，读失败只记 `degraded: true`）。

- [x] **Step 1: 失败测试**：mode=legacy 时 health 返回 `snapshot.source='legacy'` 且既有字段全保留；mode=r2 时 `snapshot.source='r2'` 且 generation 正确；D1 不可读时 health 仍 200 且 `degraded:true`。
- [x] **Step 2: 确认 FAIL**。
- [x] **Step 3: 实现**：接线 + health 构造。
- [x] **Step 4: 转绿** + 全仓 `CI=true pnpm test` 与 `pnpm typecheck` PASS。
- [x] **Step 5: 提交** `git commit -m "feat(read): switch read source and expose migration health"`

---

### Task 9: 延迟限速清理

**Files:**
- Create: `apps/sync-worker/src/legacy-cleanup.ts`
- Create: `apps/sync-worker/src/legacy-cleanup.test.ts`

**Interfaces:**
- Produces: `runLegacyCleanup(env, now): Promise<CleanupCursorV1>`——仅当 `read-mode=r2` 且 `switched_at<=now-14d`；每批 ≤100 subject 的四个 legacy key，删除前确认 pointer 存在且 R2 目标 generation 可读；cursor 单调推进；失败批次不推进。

- [x] **Step 1: 失败测试**：切换第 10 天删除 0；第 15 天 ≤100；失败批次不推进游标；至少保留一个已验证 generation（删除前校验 R2 key）。
- [x] **Step 2: 确认 FAIL**。
- [x] **Step 3: 实现**：游标 + KV delete + 校验。
- [x] **Step 4: 转绿**。
- [x] **Step 5: 提交** `git commit -m "feat(sync): rate-limited legacy cleanup after 14 days"`

---

### Task 10: 回滚操作与 runbook

**Files:**
- Create: `apps/sync-worker/src/read-mode.ts` 追加 `rollbackReadMode(store, kv): Promise<ReadModeV1>`
- Modify: `apps/read-worker/src/index.ts`（回滚后 mode=legacy 恢复旧路径）
- Modify: `docs/runbook/migrate-public-reads.md`（新建）

**Interfaces:**
- Produces: `rollbackReadMode` 把 D1 `migrate:read-mode` 与 KV `public:read-mode` 写回 `legacy`，保留 R2 对象与 generation。

- [x] **Step 1: 失败测试**：回滚后 read-worker 走 legacy 路径、R2 对象仍存在、API 契约不变；重复回滚幂等。
- [x] **Step 2: 确认 FAIL** → Step 3 实现 → Step 4 转绿。
- [x] **Step 5: 提交** `git commit -m "docs(sync): rollback read mode with preserved R2 generations"`

---

### Task 11: 每日调度接线

**Files:**
- Modify: `apps/sync-worker/src/index.ts`（scheduled handler）
- Modify: `apps/sync-worker/src/workflow-core.ts`
- Modify: `apps/sync-worker/src/workflow.test.ts`

**Interfaces:**
- Produces: 每日 20:00 UTC 触发 live legacy 发布（保持现状）后，同 instance 追加 D1 shadow 阶段：`runD1IncrementalSync`（含 media_pending）→ `runLegacyMigration` → `updateShadowStreak` → `recordDailyKvBudget` → 若 `shadowGatePassed` 则 `promoteShadowPointer`；任一 shadow 阶段失败只记录 run 状态，不阻断 legacy 发布。

- [x] **Step 1: 失败测试**：cron 20:00 同时执行 legacy 与 shadow 两阶段；shadow 阶段抛错后 legacy 仍成功且 run 记录错误；非 20:00 的 cron 仍跳过。
- [x] **Step 2: 确认 FAIL** → Step 3 实现 → Step 4 转绿（含既有 scheduled/queue 测试全过）。
- [x] **Step 5: 提交** `git commit -m "feat(sync): run daily shadow migration and gate in scheduled workflow"`

---

### Task 12: 全仓门禁与文档同步

**Files:**
- Modify: `README.md`（架构表、shadow/cutover 边界、health 字段、runbook 链接、环境变量表）
- Modify: `openspec/changes/migrate-public-reads-from-kv/tasks.md`（勾选完成项）
- Modify: `docs/superpowers/reports/2026-07-31-migrate-public-reads-from-kv-verify.md`（新建验证报告草稿）

**Interfaces:**
- Produces: 文档与实现一致；验证报告记录 runtime SHA、测试计数、生产 pending 项。

- [x] **Step 1: 更新文档**（README 各段 + tasks.md 勾选）。
- [x] **Step 2: 全仓门禁**：`CI=true pnpm test`、`pnpm typecheck`、`pnpm build:check`、`./node_modules/.bin/openspec validate migrate-public-reads-from-kv --strict`、`git diff --check` 全部 PASS。
- [x] **Step 3: 审查**：按 `review_mode` 完成代码审查并修复 CRITICAL 发现。
- [x] **Step 4: 提交** `git commit -m "docs(migrate): synchronize architecture and verification evidence"`

---

### Task 13: 生产验收（时间门禁）

**Files:**
- Modify: `docs/superpowers/reports/2026-07-31-migrate-public-reads-from-kv-verify.md`
> 以下四步为生产时间门禁（部署、7 次 shadow 观测、14 天观察、清理），完成前保持 pending，见验证报告 Explicitly pending production evidence 节：

**Interfaces:**
- Produces: 生产证据：部署 SHA、7 次每日 shadow streak、KV 写预算、切换记录、14 天观察、清理计数。

- **Step 1: 部署**到 `dev` 并确认 pipeline 通过（沿用 adopt 的验证方法：前端 Build SHA + `/api/health`/`/api/collections`/`/api/calendar` 冒烟）。
- **Step 2: 观察**连续 7 次每日 shadow 一致且预算达标（`/api/health` 的 `migration.shadow_streak`）。
- **Step 3: 切换**后 14 天观察、启用限速清理、记录 KV 写入曲线。
- **Step 4: 提交验收记录** `git commit -m "docs(migrate): record production acceptance"`

---

## Self-Review

- Spec 覆盖：5 个 delta spec 的 12 条需求逐一对应 Task 1-12；Task 13 为生产验收（OpenSpec 6.1/6.2 对应项）。
- 占位符：无 TBD/TODO；每个任务都有失败测试、实现边界与提交。
- 类型一致：`MigrationCursorV1`/`ShadowStreakV1`/`ReadModeV1`/`KvBudgetDailyV1`/`CleanupCursorV1` 从 Task 1 起定义并被后续任务复用；pointer 提升函数 `promoteShadowPointer` 签名在 Task 6/11 一致。
