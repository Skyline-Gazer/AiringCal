---
change: adopt-d1-r2-incremental-sync
design-doc: docs/superpowers/specs/2026-07-22-free-plan-d1-r2-incremental-sync-design.md
base-ref: 913362307b04f2eec7152084344eb3a8027274ad
---

# AiringCal D1/R2 增量同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将收藏、媒体、同步与 QoS 权威状态迁到 D1，把规范公开结果以不可变对象发布到独立 R2，并将 KV 写入收缩为内容变化时的一次 `public:current` pointer 更新，同时保持公开 API 继续从 legacy KV 读取。

**Architecture:** 先以不改变 Worker binding 的兼容提交扩展资源 bootstrap/resolve/materialize，并在生产真实创建 D1 与 data R2；这是 binding-dependent runtime 的强制前置门。随后以 D1 repository、纯规范化/diff planner、原子预算、pointer-last publisher 和 Worker adapters 分层实现；每日 Workflow 先完整获取上游数据，再提交 D1、发布 shadow R2 候选，现有 Read Worker 仍服务 legacy KV。

**Tech Stack:** TypeScript、Node.js 24 test runner、Cloudflare Workers/Workflows、Wrangler、D1 SQLite migrations、R2、Workers KV、Queues、pnpm workspace、OpenSpec。

## Global Constraints

- 基线必须保持为 `913362307b04f2eec7152084344eb3a8027274ad`；在隔离 worktree 中从该 SHA 创建 `feature/20260722/adopt-d1-r2-incremental-sync`。
- 修改任何 CLI flag、Wrangler config key 或 Cloudflare API call 前，必须用当前安装版 `wrangler --help`、`node_modules/wrangler/config-schema.json` 或源码验证；bgm.tv API 交互必须先核对 `docs/example/api/bgm-api.json`。
- 强制两阶段发布：Task 1 的 bootstrap/resolve 兼容提交必须先通过评审、commit、push，并在生产成功创建/复用资源；Task 2 及以后才允许加入 migration、binding 或读取 `env.AIRING_CAL_D1`/`env.AIRING_CAL_DATA_R2` 的 runtime。
- 资源名称固定：D1 `airing-cal-state`、data R2 `airing-cal-data`、image R2 `airing-cal-images`、KV `airing-cal-kv`、Queue `airing-cal-media`。
- D1 首版五张业务表不得创建二级索引；收藏规模增长到数万前不提前优化。
- 每日同步保持 `0 20 * * *` UTC，即 Asia/Shanghai 04:00。
- 相同完整输入必须达到 `collection_items` 0 行更新、data R2 0 PUT、generation 0 增、KV pointer 0 PUT。
- 任何不完整 collections 分页或 calendar 失败都不得推进 `missing_since` 或 `deleted_at`。
- 媒体预算 soft limit 50、hard limit 100；仅新增/源变化可使用 privileged headroom；不确定 Queue 提交占用预算且不得重发。
- 新 runtime 不得写 `subject:detail:*`、`subject:meta:*`、`image:status:*`、`subject:refresh:*`；图片二进制仍只写 `airing-cal-images`。
- 本 change 不切换 `/api/collections`、`/api/calendar`、`/api/health` 的公开读取来源，不执行 legacy import/cleanup，也不在媒体完成后同日二次发布。
- 日志、run 摘要和 health diagnostics 不得包含 OAuth token、完整上游错误 body 或用户评价正文。
- 每个 Task 严格执行 RED → GREEN → package/full gate → 独立 spec review → quality review → 更新 OpenSpec checkbox/进度 → atomic commit → push；评审未通过不得进入下一 Task。

## File Structure

- `scripts/cloudflare-resource-contract.mjs`：集中定义资源名称和 Cloudflare REST 响应规范化，供 provision/resolve 共用。
- `scripts/provision-cloudflare-resources.mjs`：create-or-reuse D1、两个 R2、KV、Queue，并输出真实 D1 ID。
- `scripts/resolve-cloudflare-resources.mjs`：只读验证全部资源并输出 deploy 所需 ID。
- `scripts/materialize-wrangler-config.mjs`：验证并替换 KV/D1 placeholder。
- `migrations/0001_d1_authoritative_state.sql`：五张权威表及预算 reservation 辅助表；不含二级索引。
- `packages/storage/src/canonical-json.ts`：递归规范 JSON 与 SHA-256。
- `packages/storage/src/d1-types.ts`：D1 row、公开 snapshot/pointer 和 adapter interfaces。
- `packages/storage/src/d1-state-store.ts`：收藏 diff 持久化、media/run/app state 与原子预算。
- `packages/domain/src/collection-diff.ts`：无 I/O 的收藏规范化与两次缺失 planner。
- `packages/domain/src/public-snapshot.ts`：公开 payload 构建、schema 校验、稳定 hash。
- `apps/sync-worker/src/d1-sync.ts`：完整输入与 D1 diff、媒体调度、run summary 的 orchestration。
- `apps/sync-worker/src/r2-publication.ts`：D1 commit 后的不可变 R2/pointer-last 协议。
- `apps/media-worker/src/d1-media-state.ts`：D1 媒体权威状态与 compare-before-write。
- `apps/*/wrangler.toml`、`.github/workflows/deploy.yml`：bindings 与 migration-before-upload。

---

### Task 1: 两阶段发布的资源 bootstrap/resolve 兼容层

**Files:**
- Create: `scripts/cloudflare-resource-contract.mjs`
- Create: `scripts/cloudflare-resource-contract.test.mjs`
- Modify: `scripts/provision-cloudflare-resources.mjs`
- Modify: `scripts/provision-cloudflare-resources.test.mjs`
- Modify: `scripts/resolve-cloudflare-resources.mjs`
- Modify: `scripts/resolve-cloudflare-resources.test.mjs`
- Modify: `scripts/materialize-wrangler-config.mjs`
- Modify: `scripts/materialize-wrangler-config.test.mjs`
- Modify: `.github/workflows/bootstrap-cloudflare.yml`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-29-monorepo-multi-worker-design.md`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces: `CLOUDFLARE_RESOURCES` with `d1DatabaseName`, `dataBucketName`, `imageBucketName`, `kvNamespaceTitle`, `queueNames`.
- Produces: `provisionCloudflareResources(): Promise<{ d1DatabaseId; d1DatabaseName; dataBucketName; imageBucketName; kvNamespaceId; queueNames }>`
- Produces: `resolveCloudflareResources(): Promise<{ d1DatabaseId; kvNamespaceId; dataBucketName; imageBucketName; queueNames }>`
- Produces environment/output names `AIRING_CAL_D1_DATABASE_ID` and `d1_database_id`.
- Does **not** add `[[d1_databases]]`, data R2 bindings, migration commands, or runtime accesses.

- [ ] **Step 1: Verify current CLI/config/API contracts and record evidence in the task review**

Run:

```bash
./node_modules/.bin/wrangler d1 --help
./node_modules/.bin/wrangler d1 create --help
./node_modules/.bin/wrangler d1 list --help
./node_modules/.bin/wrangler r2 bucket --help
./node_modules/.bin/wrangler r2 bucket create --help
sed -n '647,735p' node_modules/wrangler/config-schema.json
```

Expected: help lists `d1 create/list`, `r2 bucket create/list`; schema defines `d1_databases[].binding/database_name/database_id/migrations_dir` and `r2_buckets[].binding/bucket_name`. If the installed contract differs, stop and revise this plan before writing configuration.

- [ ] **Step 2: Write failing resource contract and create-or-reuse tests**

Add tests that assert exact resources and replay:

```js
assert.deepEqual(CLOUDFLARE_RESOURCES, {
  d1DatabaseName: 'airing-cal-state',
  dataBucketName: 'airing-cal-data',
  imageBucketName: 'airing-cal-images',
  kvNamespaceTitle: 'airing-cal-kv',
  queueNames: ['airing-cal-media'],
})
assert.equal(first.d1DatabaseId, '11111111-1111-4111-8111-111111111111')
assert.equal(second.d1DatabaseId, first.d1DatabaseId)
assert.equal(requests.filter((r) => r.method === 'POST').length, expectedInitialCreates)
```

Add resolve failure cases for each missing resource and assert messages end with `run the bootstrap workflow first`. Add materializer tests proving a present `<AIRING_CAL_D1_DATABASE_ID>` is rejected when missing or not a canonical UUID.

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test scripts/cloudflare-resource-contract.test.mjs scripts/provision-cloudflare-resources.test.mjs scripts/resolve-cloudflare-resources.test.mjs scripts/materialize-wrangler-config.test.mjs
```

Expected: FAIL because the shared contract, D1 create/reuse, data bucket verification, and D1 materialization do not exist.

- [ ] **Step 4: Implement the minimal compatibility layer**

Use the verified REST endpoints already followed by the scripts:

```js
export const CLOUDFLARE_RESOURCES = Object.freeze({
  d1DatabaseName: 'airing-cal-state',
  dataBucketName: 'airing-cal-data',
  imageBucketName: 'airing-cal-images',
  kvNamespaceTitle: 'airing-cal-kv',
  queueNames: ['airing-cal-media'],
})
```

Normalize D1 list responses, create only when absent, and on an already-exists race re-list before returning. Emit:

```js
return {
  d1DatabaseId: database.uuid,
  d1DatabaseName: resources.d1DatabaseName,
  dataBucketName: resources.dataBucketName,
  imageBucketName: resources.imageBucketName,
  kvNamespaceId: namespace.id,
  queueNames: resources.queueNames,
}
```

Extend materialization with:

```js
const d1DatabaseId = process.env.AIRING_CAL_D1_DATABASE_ID
config = config.replaceAll('<AIRING_CAL_D1_DATABASE_ID>', d1DatabaseId ?? '')
```

and validate with `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`. Document this as resource preparation only; do not claim runtime uses D1 yet.

- [ ] **Step 5: Run GREEN and compatibility gates**

Run:

```bash
node --test scripts/cloudflare-resource-contract.test.mjs scripts/provision-cloudflare-resources.test.mjs scripts/resolve-cloudflare-resources.test.mjs scripts/materialize-wrangler-config.test.mjs
pnpm test
pnpm typecheck
git diff --check
./node_modules/.bin/openspec validate adopt-d1-r2-incremental-sync --strict
```

Expected: all PASS; existing Wrangler files contain no D1/data R2 binding yet.

- [ ] **Step 6: Review, mark OpenSpec 1.1–1.2 complete, commit and push the compatibility SHA**

```bash
git add scripts .github/workflows/bootstrap-cloudflare.yml README.md docs/superpowers/specs/2026-06-29-monorepo-multi-worker-design.md openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: bootstrap D1 and data R2 resources"
git push -u origin feature/20260722/adopt-d1-r2-incremental-sync
```

Expected: independent spec and quality reviews approve; pushed SHA contains no binding-dependent runtime.

- [ ] **Step 7: Mandatory production bootstrap checkpoint**

Dispatch the manual `Bootstrap Cloudflare Resources` workflow at the accepted SHA, wait for success, and verify its logs expose a canonical `d1_database_id` without secrets. Then run the read-only resolver with production credentials.

Expected: D1 `airing-cal-state`, R2 `airing-cal-data`, R2 `airing-cal-images`, KV and Queue all resolve. **Do not begin Task 2 until this checkpoint passes.**

- [ ] **Step 8: Record the production resource evidence, mark OpenSpec 1.3 complete, commit and push**

Record the workflow URL, run ID, canonical D1 ID, resource names and read-only resolver result in `.comet/subagent-progress.md`. Do not record credentials or API response headers.

```bash
git add openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "docs: record D1 R2 bootstrap completion"
git push
```

Expected: task 1.3 is checked only after production evidence exists; Task 2 may now begin.

---

### Task 2: D1 migration 与 typed state contracts

**Files:**
- Create: `migrations/0001_d1_authoritative_state.sql`
- Create: `packages/storage/wrangler.d1-test.toml`
- Create: `packages/storage/src/d1-types.ts`
- Create: `packages/storage/src/d1-migration.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/package.json`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces `CollectionRow`, `SubjectMediaRow`, `SyncRunRow`, `SyncBudgetResource`, `AppStateRow`.
- Produces `PublicSnapshotV1`, `PublicSnapshotPointerV1`, `D1DatabaseLike`, `D1PreparedStatementLike`.
- Schema tables: `collection_items`, `subject_media`, `sync_runs`, `sync_budget`, `app_state`; helper table `sync_budget_reservations` is permitted solely for stable reservation idempotency.

- [ ] **Step 1: Write RED migration-shape and idempotency tests**

Read the SQL and assert all primary keys, required columns, foreign-key-free deployability, and no `CREATE INDEX`. Create a test-only local Wrangler config:

```toml
name = "airing-cal-d1-migration-test"
main = "src/index.ts"
compatibility_date = "2026-07-22"

[[d1_databases]]
binding = "AIRING_CAL_D1"
database_name = "airing-cal-state"
database_id = "11111111-1111-4111-8111-111111111111"
migrations_dir = "../../migrations"
```

Apply the migration twice to isolated local D1 state using the verified command:

```bash
./node_modules/.bin/wrangler d1 migrations apply AIRING_CAL_D1 --local --persist-to /tmp/airing-cal-d1-plan-test --config packages/storage/wrangler.d1-test.toml
```

Expected RED: migration/config do not exist. The test must inspect `sqlite_schema` and require exactly the intended tables plus Wrangler’s migration bookkeeping.

- [ ] **Step 2: Define exact TypeScript contracts**

Use integer epoch seconds and JSON text at the database boundary:

```ts
export type Temperature = 'hot' | 'cold'
export type SyncBudgetResource = 'media'
export interface CollectionRow {
  user_id: string
  subject_id: number
  collection_type: number
  rate: number | null
  tags_json: string
  comment: string
  ep_status: number
  vol_status: number
  upstream_updated_at: string | null
  subject_json: string
  content_hash: string
  temperature: Temperature
  first_seen_at: number
  changed_at: number
  missing_since: number | null
  deleted_at: number | null
}
export interface PublicSnapshotPointerV1 {
  schema_version: 1
  generation: number
  content_hash: string
  r2_key: string
  published_at: number
}
```

`SyncRunRow.error_code` stores only a classified error code; no upstream body/comment field exists.

- [ ] **Step 3: Implement migration**

Create tables with `PRIMARY KEY (user_id, subject_id)`, `PRIMARY KEY (date, resource)`, and `PRIMARY KEY (key)` as designed. `sync_budget_reservations` uses `reservation_id TEXT PRIMARY KEY`, immutable request fingerprint/result JSON, and `submission_status CHECK (...)`. Do not add secondary indexes or triggers that update unchanged rows.

- [ ] **Step 4: Run GREEN gates**

Run:

```bash
node --import tsx --test packages/storage/src/d1-migration.test.ts
pnpm -F @airing-cal/storage typecheck
pnpm -F @airing-cal/storage test
git diff --check
```

Expected: migration applies once, replay reports no pending migration rather than duplicating schema; typecheck/test PASS.

- [ ] **Step 5: Review, mark 2.1 complete, commit and push**

```bash
git add migrations packages/storage openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: define D1 authoritative state schema"
git push
```

---

### Task 3: 规范 JSON、业务 hash 与公开契约

**Files:**
- Create: `packages/storage/src/canonical-json.ts`
- Create: `packages/storage/src/canonical-json.test.ts`
- Create: `packages/domain/src/public-snapshot.ts`
- Create: `packages/domain/src/public-snapshot.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces `canonicalize(value: unknown): unknown`.
- Produces `canonicalJson(value: unknown): string`.
- Produces `sha256Canonical(value: unknown): Promise<string>`.
- Produces `buildPublicSnapshot(input, generation): Promise<PublicSnapshotV1>`.
- Produces `parsePublicSnapshotV1(value: unknown): PublicSnapshotV1`.
- Produces `snapshotObjectKey(snapshot): string`.

- [ ] **Step 1: Write RED canonicalization tests**

Cover recursive key order, array order preservation, `undefined` normalization to `null`, missing optional fields supplied by the domain mapper, UTF-8, and runtime-field exclusion:

```ts
assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}')
assert.equal(await sha256Canonical({ a: 1, b: 2 }), await sha256Canonical({ b: 2, a: 1 }))
assert.notEqual(await collectionContentHash({ ...base, rate: 8 }), await collectionContentHash({ ...base, rate: 9 }))
assert.equal(await collectionContentHash({ ...base, fetched_at: 1 }), await collectionContentHash({ ...base, fetched_at: 2 }))
```

Also assert tags, comment, type and progress change hashes even when `upstream_updated_at` is unchanged.

- [ ] **Step 2: Write RED snapshot schema/hash tests**

Assert `generation`, `content_hash`, and `published_at` are excluded from payload hash; unknown `schema_version` throws `Unsupported public snapshot schema_version`; key is exactly:

```ts
`snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`
```

- [ ] **Step 3: Implement minimal helpers**

Recursively sort plain-object keys, preserve arrays, reject non-finite numbers, convert explicit `undefined` values to `null`, use `crypto.subtle.digest('SHA-256', TextEncoder(...))`, and return lowercase 64-char hex. `buildPublicSnapshot` groups all five collection types, calendar, summary, public image refs and NSFW projection.

- [ ] **Step 4: Run GREEN gates**

```bash
node --import tsx --test packages/storage/src/canonical-json.test.ts packages/domain/src/public-snapshot.test.ts
pnpm -F @airing-cal/storage test
pnpm -F @airing-cal/domain test
pnpm -F @airing-cal/storage typecheck
pnpm -F @airing-cal/domain typecheck
```

Expected: all PASS and repeated content yields identical hash.

- [ ] **Step 5: Review, mark 2.2 and 4.1 complete, commit and push**

```bash
git add packages/storage packages/domain openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: add canonical D1 and snapshot contracts"
git push
```

---

### Task 4: 收藏内存 diff 与两次缺失确认

**Files:**
- Create: `packages/domain/src/collection-diff.ts`
- Create: `packages/domain/src/collection-diff.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `apps/sync-worker/src/workflow-core.ts`
- Modify: `apps/sync-worker/src/workflow.test.ts`
- Modify: `docs/example/api/bgm-api.json` only if the verified checked-in API contract itself is stale; otherwise do not edit it
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces `normalizeCollection(userId, BgmCollection): Promise<NormalizedCollection>`.
- Produces `planCollectionDiff({ current, incoming, complete, observedAt }): Promise<CollectionDiffPlan>`.
- `CollectionDiffPlan = { inserts: CollectionRow[]; updates: CollectionRow[]; unchanged: number; firstMissing: CollectionRow[]; confirmedDeleted: CollectionRow[]; restored: CollectionRow[] }`.
- `complete: false` must return no first-missing/deletion transitions.

- [ ] **Step 1: Verify bgm.tv fields before mapper work**

Run:

```bash
rg -n 'UserSubjectCollection|Subject|updated_at|ep_status|vol_status|rate|tags|comment' docs/example/api/bgm-api.json packages/bgm-api
```

Expected: every mapped field is present in the checked-in contract or existing generated/client types. Do not invent fields.

- [ ] **Step 2: Write RED table-driven planner tests**

Cases: empty D1 insert; identical business content zero write despite new observed time; rate/tag/comment/type/progress single-row update; first missing; second successful missing; reappearance clears missing/deleted; `complete: false` produces no missing/deletion writes.

```ts
assert.deepEqual(plan.firstMissing.map(keyOf), ['ian:1'])
assert.equal(second.confirmedDeleted[0].deleted_at, day2)
assert.deepEqual(failedPage.firstMissing, [])
assert.deepEqual(failedPage.confirmedDeleted, [])
```

- [ ] **Step 3: Run RED**

```bash
node --import tsx --test packages/domain/src/collection-diff.test.ts
```

Expected: FAIL because normalizer/planner are absent.

- [ ] **Step 4: Implement pure normalizer/planner and full-fetch boundary**

Map `watched` to `cold`, every other active collection state to `hot`; sort tags before hashing only when tag order is not part of the public API contract. The Workflow must construct `complete = true` only after every declared collection page and calendar succeeded; it must never pass partial pages to deletion planning.

- [ ] **Step 5: Run GREEN**

```bash
node --import tsx --test packages/domain/src/collection-diff.test.ts apps/sync-worker/src/workflow.test.ts
pnpm -F @airing-cal/domain test
pnpm -F @airing-cal/sync-worker test
pnpm -F @airing-cal/sync-worker typecheck
```

- [ ] **Step 6: Review, mark 3.1–3.2 complete, commit and push**

```bash
git add packages/domain apps/sync-worker docs/example/api/bgm-api.json openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: plan incremental collection changes"
git push
```

---

### Task 5: Typed D1 adapter 与零写收藏提交

**Files:**
- Create: `packages/storage/src/d1-state-store.ts`
- Create: `packages/storage/src/d1-state-store.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/d1-types.ts`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces class `D1StateStore`.
- Produces `listCollectionRows(): Promise<CollectionRow[]>`.
- Produces `applyCollectionDiff(plan: CollectionDiffPlan): Promise<{ rowsWritten: number }>` using one D1 batch after planning.
- Produces `getAppState<T>(key): Promise<T | undefined>`, `putAppState<T>(key, value): Promise<void>`.
- Produces `startSyncRun`, `updateSyncRun`, `completeSyncRun`, `failSyncRun`.

- [ ] **Step 1: Write RED adapter tests with a recording D1 fake**

Require exact statement counts:

```ts
assert.equal((await store.applyCollectionDiff(noChanges)).rowsWritten, 0)
assert.equal(fake.batchCalls.length, 0)
assert.equal((await store.applyCollectionDiff(oneChanged)).rowsWritten, 1)
assert.equal(fake.batchCalls[0].length, 1)
```

Test row JSON decoding, corrupt app-state version rejection, error redaction, and bounded batches (maximum 50 statements per `batch` call).

- [ ] **Step 2: Implement minimal repository**

Use prepared statements with positional binds and explicit column lists. Never issue an UPDATE for `unchanged`; never write `last_seen_at`. Batch only insert/update/state-transition rows and return actual statement count.

- [ ] **Step 3: Run GREEN**

```bash
node --import tsx --test packages/storage/src/d1-state-store.test.ts
pnpm -F @airing-cal/storage test
pnpm -F @airing-cal/storage typecheck
```

- [ ] **Step 4: Review, complete remaining 2.2 evidence, commit and push**

```bash
git add packages/storage openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: persist incremental state in D1"
git push
```

---

### Task 6: D1 原子 QoS reservation 与七日冷热调度

**Files:**
- Create: `packages/storage/src/d1-budget.ts`
- Create: `packages/storage/src/d1-budget.test.ts`
- Modify: `packages/storage/src/d1-state-store.ts`
- Modify: `apps/sync-worker/src/refresh-planner.ts`
- Modify: `apps/sync-worker/src/refresh-planner.test.ts`
- Modify: `apps/sync-worker/src/snapshot-coordinator.ts`
- Modify: `apps/sync-worker/src/snapshot-coordinator.test.ts`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces `reserveDailyBudget(request: BudgetReservationRequest): Promise<BudgetReservationResult>`.
- `BudgetReservationRequest = { date; resource: 'media'; reservationId; jobs; privilegedCount; softLimit: 50; hardLimit: 100 }`.
- Produces `positiveMod(subjectId: number, divisor: 7): number`.
- Produces priority order `new_or_changed → hot → cold → retry`.
- Existing Durable Object `/reserve-media` path is removed from the new Workflow only after D1 tests prove parity; legacy compatibility may remain unused until later cleanup.

- [ ] **Step 1: Write RED budget replay/concurrency tests**

Use a D1 fake capable of serializing transactions. Two concurrent calls for the last slot must yield grants `[0, 1]` in either order, total reserved/consumed `<= 100`; same `reservationId` returns byte-equivalent result; changed payload with same ID throws `reservation payload mismatch`; uncertain submission remains occupied and replay does not invoke Queue.

- [ ] **Step 2: Write RED hot/cold tests**

For seven consecutive UTC date shards, each watched subject appears exactly once when budget is ample. Assert source change/new uses privileged headroom, hot expiry precedes cold, cold precedes retry, same subject merges to one job, and a persisted cursor resumes deferred cold IDs.

- [ ] **Step 3: Implement reservation and planner**

Use a stable request fingerprint, `INSERT ... ON CONFLICT DO NOTHING` for the reservation claim, then read the stored result. Update budget and reservation status within the same D1 transaction/session supported by the verified Workers D1 API. Queue submission occurs at most once after commit; ambiguous result writes `uncertain`, never releases grant.

- [ ] **Step 4: Run GREEN**

```bash
node --import tsx --test packages/storage/src/d1-budget.test.ts apps/sync-worker/src/refresh-planner.test.ts apps/sync-worker/src/snapshot-coordinator.test.ts
pnpm -F @airing-cal/storage test
pnpm -F @airing-cal/sync-worker test
pnpm -F @airing-cal/storage typecheck
pnpm -F @airing-cal/sync-worker typecheck
```

- [ ] **Step 5: Review, mark 2.3 and scheduler portion of 3.3 complete, commit and push**

```bash
git add packages/storage apps/sync-worker openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: reserve media work atomically in D1"
git push
```

---

### Task 7: D1 增量 Workflow orchestration

**Files:**
- Create: `apps/sync-worker/src/d1-sync.ts`
- Create: `apps/sync-worker/src/d1-sync.test.ts`
- Modify: `apps/sync-worker/src/workflow-core.ts`
- Modify: `apps/sync-worker/src/workflow.ts`
- Modify: `apps/sync-worker/src/workflow.test.ts`
- Modify: `packages/storage/src/d1-state-store.ts`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces `runD1IncrementalSync({ env, instanceId, completeInput, now }): Promise<D1SyncResult>`.
- `D1SyncResult` includes `{ rowsWritten; firstMissing; deleted; restored; publicationInput; media: { candidates; granted; confirmed; uncertain; deferred }; runId }`.
- Media outcome never changes the collection diff/publication eligibility result.

- [ ] **Step 1: Write RED end-to-end orchestration tests**

Use Bgm client fixtures plus recording D1/Queue fakes. Assert:

```ts
assert.equal(unchanged.rowsWritten, 0)
assert.equal(changed.rowsWritten, 1)
assert.equal(mediaFailure.publicationInput.content_hash, expectedHash)
assert.equal(partialFetch.d1WritesForMissingTransitions, 0)
assert.equal(legacyKv.writesMatching(/^subject:|^image:status:/), 0)
```

Also prove a 401/403 is classified non-retryable, 429/5xx/network retains bounded retry semantics, and run errors contain codes rather than upstream bodies.

- [ ] **Step 2: Implement D1 orchestration behind shadow mode**

Keep existing legacy snapshot publication intact. After a complete fetch, load D1 once, apply the pure plan, persist run counters, reserve media, and return a canonical publication input. On partial failure, fail the run without invoking diff commit. Use stable `instanceId` for replay.

- [ ] **Step 3: Run GREEN**

```bash
node --import tsx --test apps/sync-worker/src/d1-sync.test.ts apps/sync-worker/src/workflow.test.ts
pnpm -F @airing-cal/sync-worker test
pnpm -F @airing-cal/sync-worker typecheck
```

- [ ] **Step 4: Review, mark 3.3 complete, commit and push**

```bash
git add apps/sync-worker packages/storage openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: run daily incremental D1 sync"
git push
```

---

### Task 8: Media Worker 的 D1 权威状态

**Files:**
- Create: `apps/media-worker/src/d1-media-state.ts`
- Create: `apps/media-worker/src/d1-media-state.test.ts`
- Modify: `apps/media-worker/src/index.ts`
- Modify: `apps/media-worker/src/media-worker.test.ts`
- Modify: `apps/media-worker/src/subject-refresh-coordinator.ts`
- Modify: `packages/storage/src/d1-state-store.ts`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces `refreshSubjectMediaD1(env, job): Promise<{ d1Writes; imageWrites; status }>` with status `unchanged|updated|retry_scheduled`.
- Reads/writes `subject_media`; image bytes continue through existing `R2ImageStore` and existing object keys.

- [ ] **Step 1: Write RED compare-before-write tests**

Assert same detail/media hash, source URLs and R2 refs produce zero D1/image writes; changed common image writes only that image plus one D1 row; error updates only retry classification/backoff; no new legacy per-subject KV keys are put.

- [ ] **Step 2: Implement D1 media state path**

Acquire/read the subject row, fetch detail, calculate canonical hashes, compare before each D1/R2 write, preserve existing image keys, and store `checked_at/next_refresh_at/retry_count/retry_at/error_code`. Never store upstream error bodies.

- [ ] **Step 3: Run GREEN**

```bash
node --import tsx --test apps/media-worker/src/d1-media-state.test.ts apps/media-worker/src/media-worker.test.ts
pnpm -F @airing-cal/media-worker test
pnpm -F @airing-cal/media-worker typecheck
```

- [ ] **Step 4: Review, complete cache-refresh lifecycle coverage, commit and push**

```bash
git add apps/media-worker packages/storage openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: persist media state in D1"
git push
```

---

### Task 9: 不可变 R2 与 pointer-last 发布

**Files:**
- Create: `apps/sync-worker/src/r2-publication.ts`
- Create: `apps/sync-worker/src/r2-publication.test.ts`
- Modify: `apps/sync-worker/src/d1-sync.ts`
- Modify: `apps/sync-worker/src/workflow-core.ts`
- Modify: `packages/storage/src/d1-state-store.ts`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Produces `publishPublicSnapshot({ state, dataBucket, pointerKv, input, now }): Promise<PublicationResult>`.
- `PublicationResult = { status: 'unchanged'|'published'|'pending'; generation; contentHash; r2Puts; pointerPuts }`.
- D1 `app_state` keys: `public:verified`, `public:pending`; versioned JSON only.

- [ ] **Step 1: Write RED no-op and success tests**

Assert identical verified hash returns `unchanged`, does not allocate generation, and produces zero R2/KV PUT. Changed content must observe calls in exact order:

```ts
assert.deepEqual(events, [
  'd1:commit-state',
  'r2:put',
  'r2:get',
  'kv:put:public:current',
  'd1:mark-published',
])
```

The object body must round-trip through `parsePublicSnapshotV1` and hash verification.

- [ ] **Step 2: Write RED failure-injection/replay tests**

Inject D1 commit, R2 PUT, R2 GET, schema, generation, content hash, object-key, KV definite failure and KV ambiguous outcome. In every pre-pointer failure assert the old pointer is byte-identical. For ambiguous KV PUT, read back: exact candidate means success; mismatch/missing means pending. Replay uses the same generation/key and performs no additional allocation.

- [ ] **Step 3: Implement publisher**

Read verified/pending state; content equality short-circuits before generation allocation. Persist pending generation/hash, PUT with an `onlyIf` precondition supported by the verified R2 type or perform GET-and-exact-compare when object exists; GET and validate full object; then one KV PUT. Complete D1 state only after pointer result is verified.

- [ ] **Step 4: Run GREEN**

```bash
node --import tsx --test apps/sync-worker/src/r2-publication.test.ts apps/sync-worker/src/d1-sync.test.ts apps/sync-worker/src/workflow.test.ts
pnpm -F @airing-cal/sync-worker test
pnpm -F @airing-cal/sync-worker typecheck
```

- [ ] **Step 5: Review, mark 4.2–4.3 complete, commit and push**

```bash
git add apps/sync-worker packages/storage openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: publish immutable R2 snapshots pointer last"
git push
```

---

### Task 10: Bindings、migration-before-upload 与 dry-run 门禁

**Files:**
- Modify: `apps/sync-worker/wrangler.toml`
- Modify: `apps/media-worker/wrangler.toml`
- Modify: `apps/read-worker/wrangler.toml`
- Modify: `apps/sync-worker/worker-configuration.d.ts`
- Modify: `apps/media-worker/worker-configuration.d.ts`
- Modify: `apps/read-worker/worker-configuration.d.ts`
- Modify: `apps/sync-worker/src/index.ts`
- Modify: `apps/media-worker/src/index.ts`
- Modify: `apps/read-worker/src/index.ts`
- Modify: `.github/workflows/deploy.yml`
- Modify: `packages/worker-common/src/deploy-config.test.ts`
- Modify: `scripts/materialize-wrangler-config.test.mjs`
- Modify: `scripts/resolve-cloudflare-resources.test.mjs`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Binding names: `AIRING_CAL_D1`, `AIRING_CAL_DATA_R2`, existing `AIRING_CAL_R2`, `AIRING_CAL_KV`, `MEDIA_QUEUE`.
- Config D1 ID placeholder: `<AIRING_CAL_D1_DATABASE_ID>`.
- Deploy dependency order: resolve → migration → read/media → sync/Workflow → frontend.

- [ ] **Step 1: Re-verify config and migration CLI immediately before config edits**

```bash
./node_modules/.bin/wrangler d1 migrations apply --help
sed -n '647,735p' node_modules/wrangler/config-schema.json
rg -n 'interface Env|AIRING_CAL_R2|AIRING_CAL_KV' apps/*/src apps/*/worker-configuration.d.ts
```

Expected: `--remote` is supported; binding/config fields match Task 1 evidence.

- [ ] **Step 2: Write RED config/deploy-order tests**

Require sync: D1 + data R2 + KV + Queue; media: D1 + image R2; read: D1 + both R2 + KV. Parse workflow jobs and assert `apply_d1_migrations` needs resolver and both upload jobs need migration:

```ts
assert.deepEqual(deployOrder, ['resolve_cloudflare', 'apply_d1_migrations', 'deploy_read_media_workers', 'deploy_sync_worker', 'deploy_frontend_worker'])
```

Materialization with an unresolved D1 placeholder must fail before dry-run.

- [ ] **Step 3: Implement configs and CI**

Add verified TOML:

```toml
[[d1_databases]]
binding = "AIRING_CAL_D1"
database_name = "airing-cal-state"
database_id = "<AIRING_CAL_D1_DATABASE_ID>"
migrations_dir = "../../migrations"

[[r2_buckets]]
binding = "AIRING_CAL_DATA_R2"
bucket_name = "airing-cal-data"
```

Add migration job command:

```bash
pnpm exec wrangler d1 migrations apply AIRING_CAL_D1 --remote --config "$RUNNER_TEMP/wrangler-sync-worker.toml"
```

It must materialize config first and be a hard dependency of every upload. Read Worker accepts bindings but its handlers remain on legacy KV.

- [ ] **Step 4: Regenerate Worker types using the repository’s verified script**

Run:

```bash
pnpm -F @airing-cal/read-worker cf:types
pnpm -F @airing-cal/media-worker cf:types
pnpm -F @airing-cal/sync-worker cf:types
```

Expected: generated env types expose the exact binding names and TypeScript compiles.

- [ ] **Step 5: Run GREEN config gates and dry-runs**

Use a syntactically valid test D1 UUID and KV ID:

```bash
AIRING_CAL_D1_DATABASE_ID=11111111-1111-4111-8111-111111111111 AIRING_CAL_KV_NAMESPACE_ID=11111111111111111111111111111111 node scripts/materialize-wrangler-config.mjs apps/read-worker/wrangler.toml /tmp/wrangler-read.toml
pnpm exec wrangler deploy --dry-run --outdir /tmp/airing-cal-read-dry --config /tmp/wrangler-read.toml
pnpm test
pnpm typecheck
pnpm build:check
```

Repeat materialize/dry-run for media and sync. Expected: all PASS; grep shows no placeholder in `/tmp/wrangler-*.toml`.

- [ ] **Step 6: Review, mark 5.1–5.2 complete, commit and push**

```bash
git add apps .github/workflows/deploy.yml packages/worker-common scripts openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "feat: bind D1 and data R2 after migrations"
git push
```

---

### Task 11: 文档、回滚与全仓约束同步

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md`
- Modify: `docs/superpowers/specs/2026-06-29-monorepo-multi-worker-design.md`
- Modify: `docs/superpowers/specs/2026-07-10-free-plan-sync-workflow-design.md`
- Modify: `docs/superpowers/specs/2026-07-22-stop-kv-write-amplification-design.md`
- Modify: `docs/rules/docs-sync.md` only when a durable new repository constraint is introduced
- Create: `docs/superpowers/reports/2026-07-22-adopt-d1-r2-incremental-sync-verify.md`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`

**Interfaces:**
- Documents exact resource/binding/env names, daily schedule, shadow-only read boundary, migration-before-upload, failure recovery, previous-SHA rollback, and no destructive reverse migration.

- [ ] **Step 1: Write a documentation truth-table before editing**

List every code-backed statement and its evidence path: resources, bindings, five tables, budget limits, pointer key/object key, deploy order, public read source, rollback, secret redaction. Any statement without code/test evidence must be omitted or explicitly labeled future change.

- [ ] **Step 2: Update docs and run stale-claim scan**

```bash
rg -n '0 \*/4|every 4 hours|每 4 小时|KV.*权威|逐 subject KV|D1.*future|R2.*future|/__cron/sync' README.md docs
```

Expected: remaining matches are clearly historical/prohibited or are corrected. State explicitly that `migrate-public-reads-from-kv` owns cutover/import/cleanup.

- [ ] **Step 3: Run docs/config gates**

```bash
node --test packages/worker-common/src/deploy-config.test.ts scripts/*.test.mjs
./node_modules/.bin/openspec validate adopt-d1-r2-incremental-sync --strict
git diff --check
```

- [ ] **Step 4: Review, mark 5.3 complete, commit and push**

```bash
git add README.md docs openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "docs: document D1 R2 shadow architecture"
git push
```

---

### Task 12: 完整验证、生产 migration 与 shadow release

**Files:**
- Modify: `docs/superpowers/reports/2026-07-22-adopt-d1-r2-incremental-sync-verify.md`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/tasks.md`
- Modify: `openspec/changes/adopt-d1-r2-incremental-sync/.comet/subagent-progress.md`

**Interfaces:**
- Produces immutable verification evidence for exact reviewed/deployed SHA.
- Does not switch public Read Worker to R2.

- [ ] **Step 1: Run exact local full gates**

```bash
pnpm test
pnpm typecheck
pnpm build:check
./node_modules/.bin/openspec validate adopt-d1-r2-incremental-sync --strict
git diff --check
```

Expected: all PASS. Record test counts and exact HEAD in the verification report.

- [ ] **Step 2: Run all materialized Wrangler dry-runs**

Materialize read/media/sync/frontend configs with canonical test IDs, assert no placeholders, then run `pnpm exec wrangler deploy --dry-run` for each exact config.

Expected: all four dry-runs PASS; sync output exposes Workflow, D1, data R2, KV and Queue; read/media outputs match their binding matrices.

- [ ] **Step 3: Perform requirement-by-requirement independent review**

Review every OpenSpec requirement and Design §10 acceptance criterion against source plus executable evidence. In particular prove:

- identical replay: D1 collection 0 writes, R2 0 PUT, KV pointer 0 PUT;
- business changes detected without `updated_at`;
- first/second missing and partial-page protection;
- concurrent/replayed budget `<= 100`;
- no new per-subject legacy KV writes;
- all injected publication failures preserve old pointer;
- public APIs still use legacy KV.

Expected: spec and code-quality reviewers both return APPROVED; otherwise create a focused RED test and fix as a new atomic commit before continuing.

- [ ] **Step 4: Commit/push verification-ready documentation**

```bash
git add docs/superpowers/reports/2026-07-22-adopt-d1-r2-incremental-sync-verify.md openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "test: verify D1 R2 incremental sync"
git push
```

- [ ] **Step 5: Obtain the production-integration decision, merge the reviewed release candidate, and deploy its immutable SHA**

Production shadow evidence cannot be collected from a feature ref because the repository deployment workflow only accepts commits already contained in `dev`. This is therefore an explicit build-stage production-integration decision point: present the reviewed release-candidate SHA and wait for the user to authorize local merge to `dev`, PR integration, or keeping the branch pending. Do not infer the choice.

When the user authorizes local merge, fast-forward or merge the reviewed feature branch into `dev`, rerun the full gates on the merged result, push `dev`, and observe `Deploy to Cloudflare`. Keep the change in build phase until the production evidence and OpenSpec 6.2 checkbox are committed. Do not claim that this step is the later Comet verify `finishing-a-development-branch` gate.

Verify the deployment workflow executes:

```text
resolve_cloudflare
→ apply_d1_migrations
→ deploy_read_media_workers
→ deploy_sync_worker
→ deploy_frontend_worker
```

Expected: remote migration succeeds before first upload; all deploy jobs use the same full SHA. If the user does not authorize integration, leave Task 12 and OpenSpec 6.2 pending.

- [ ] **Step 6: Verify production shadow behavior**

Trigger or wait for one daily shadow-capable run. Query control-plane/application diagnostics without exposing secrets and record:

- resolved D1/data R2/image R2/KV/Queue;
- D1 rows written and budget counters;
- immutable R2 key/schema/generation/hash and successful readback;
- KV `public:current` writes 0 on unchanged replay or exactly 1 on changed publish;
- legacy and shadow five collection counts, subject IDs, calendar, image refs and NSFW projection;
- public `/api/collections`, `/api/calendar`, `/api/health`, `/api/cache` remain compatible and sourced from legacy path.

Expected: shadow publication succeeds, metrics match application counters, public production smoke tests pass.

- [ ] **Step 7: Finalize OpenSpec/Comet state atomically**

Mark 6.1–6.2 and every remaining task complete only after evidence exists. Update the verification report/progress with workflow URL, run ID, deployed SHA and observed counters:

```bash
git add docs/superpowers/reports/2026-07-22-adopt-d1-r2-incremental-sync-verify.md openspec/changes/adopt-d1-r2-incremental-sync
git commit -m "docs: record D1 R2 shadow release"
git push origin dev
```

Expected: change passes Comet verify and may be archived; the next separate change remains responsible for public read migration, legacy import/cutover/fallback and cleanup.

- [ ] **Step 8: Run the build guard, then enter Comet verify and its separate branch-handling gate**

After every OpenSpec task is complete and production evidence is committed on `dev`, run:

```bash
COMET_ENV=$(find . "$HOME"/.*/skills "$HOME/.config" "$HOME/.gemini" -path '*/comet/scripts/comet-env.sh' -type f -print -quit 2>/dev/null)
. "$COMET_ENV"
"$COMET_BASH" "$COMET_GUARD" adopt-d1-r2-incremental-sync build --apply
```

Expected: `ALL CHECKS PASSED`, phase advances to `verify`. Run `/comet-verify`; its `finishing-a-development-branch` decision remains mandatory even if the release candidate was already integrated for production evidence (the valid choice may be “keep as-is” when no feature branch remains).

## Coverage Audit

| OpenSpec task / acceptance criterion | Implemented and proven by |
|---|---|
| 1.1 Wrangler/API verification | Task 1 Step 1; Task 10 Step 1 |
| 1.2 create/reuse all resources | Task 1 Steps 2–5 |
| 1.3 D1 ID materialization + production bootstrap before bindings | Task 1 Steps 2–7; mandatory barrier |
| 2.1 five-table model, no secondary indexes | Task 2 |
| 2.2 typed adapters, canonical JSON/hash, row mapping | Tasks 2, 3, 5 |
| 2.3 atomic/replay-safe/concurrent budget | Task 6 |
| 3.1 full fetch + runtime-field-free diff | Tasks 4, 7 |
| 3.2 two-successful-missing + failure protection | Task 4 |
| 3.3 runs, hot/cold, no new legacy state | Tasks 6–8 |
| 4.1 snapshot/pointer schemas and deterministic hash | Task 3 |
| 4.2 D1 → R2 → verify → pointer; no-op | Task 9 |
| 4.3 failure injection, replay, old pointer | Task 9 |
| 5.1 internal bindings with compatibility | Task 10 |
| 5.2 migration-before-upload and dry-run | Task 10 |
| 5.3 docs/runbooks/rollback | Task 11 |
| 6.1 package/full gates and materialized dry-runs | Task 12 Steps 1–3 |
| 6.2 production shadow release and metrics | Task 12 Steps 5–7 |
| Existing public API stays on legacy KV | Tasks 7, 10, 12 |
| No same-day media republish/import/cleanup | Global Constraints; Tasks 8–12 |

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-22-free-plan-d1-r2-incremental-sync.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 使用 `superpowers:subagent-driven-development`，每个 Task 使用新 subagent，并在 Task 间执行 spec 与质量双阶段评审。
2. **Inline Execution** — 使用 `superpowers:executing-plans`，在本会话分批执行并设置检查点。
