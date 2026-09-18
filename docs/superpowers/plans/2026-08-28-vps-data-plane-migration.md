---
change: migrate-data-plane-to-vps
design-doc: docs/superpowers/specs/2026-08-28-vps-data-plane-migration-design.md
base-ref: ab623355210d38a3cd6cae0c5591aca6b4cc271e
---

# VPS Data Plane Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将周期同步、媒体缓存、PostgreSQL 权威状态、R2 不可变发布、备份和飞书通知迁入一个 VPS 一次性 TypeScript 容器，同时保持 Cloudflare 公开 URL 与响应结构不变。

**Architecture:** 新增 `apps/vps-sync` 作为 Node composition root，以端口驱动的 sync core 组合 PostgreSQL、bgm.tv、S3-compatible R2、`pg_dump`/`pg_restore` 和飞书适配器；纯 snapshot/manifest/retry/retention 规则留在共享包。Read Worker 只验证 R2 manifest/snapshot 并执行 R2 → Cache API → legacy KV fallback，绝不访问 VPS 或 PostgreSQL。

**Tech Stack:** TypeScript 6、Node.js `node:alpine`、pnpm workspace、`pg`、AWS SDK S3 client、PostgreSQL、Cloudflare R2/Workers Cache API、Docker Compose、GitHub Actions/GHCR、`tsx --test`。

## Global Constraints

- 遵守 `docs/rules/docs-sync.md`：写入任何 CLI flag、配置 key、第三方 API 或 bgm.tv 调用前，先以 `--help`、本地 types、源码、`docs/example/api/bgm-api.json` 或官方文档验证；验证证据写入对应 task 的 commit message body 或 PR notes。
- 严格按 RED → 观察预期失败 → 最小 GREEN → REFACTOR；每个 OpenSpec task 完成后单独 `git commit` 并立即 `git push`，不得跨 task 积攒。
- 每个代码 task 同步更新其覆盖的 README/runbook/架构文档；用户文档只能描述已经在同一提交中实现并验证的行为。
- PostgreSQL 只通过标准 `DATABASE_URL`；禁止供应商 SDK、公开监听端口、CF 到 VPS/数据库连接，以及数据库内的任何 secret。
- Collection/calendar 只有完整抓取后才能在单事务中提交；媒体失败保留 last-known-good 并允许发布，但 run 必须为 `partial`。
- VPS 是 detail/metadata/image 的唯一新生产者；Cloudflare 只读 R2。Shadow 期旧 Media Worker 仍运行，live 切换前停止旧写入者。
- `PublicSnapshotV1` 公开 shape 不变；新 manifest 使用精确 V1 keys、UTC ISO 时间、64 位小写 SHA-256 和完整 40 位小写 git SHA。
- Production image 使用官方浮动 `node:alpine` 构建，但 Compose 只引用 `ghcr.io/skyline-gazer/airing-cal-sync:` 后跟完整 40 位 git SHA 的 tag；debug image 只允许手动发布“完整 SHA 后缀 `-debug`”的 tag。
- 任何生产切流、停用 scheduler 或资源清理都必须由用户显式批准；本计划不得自动删除 D1、KV、Queue、Workflow、Durable Object 或 R2 历史对象。

## File Structure

- Create `apps/vps-sync/src/contracts.ts` — sync core 的配置、端口、stage/result 类型。
- Create `apps/vps-sync/src/postgres/` — migration runner、SQL migrations、规范化 repositories 与 advisory locks。
- Create `apps/vps-sync/src/upstream/` — 完整抓取、retry 与现有 bgm client 的 Node adapter。
- Create `apps/vps-sync/src/media/` — detail/metadata/image 刷新、stale fence 与 last-known-good。
- Create `apps/vps-sync/src/publication/` — S3 adapter 与 pending/verified 发布状态机。
- Create `apps/vps-sync/src/backup/` — dump、manifest、retention 与 restore verification。
- Create `apps/vps-sync/src/notification/` — 飞书消息、签名、投递与 redaction。
- Create `apps/vps-sync/src/run.ts` / `cli.ts` — 一次性协调器与 `sync|migrate|backup|restore-verify` 命令。
- Modify `packages/domain/src/public-snapshot.ts` — manifest contract、canonical bytes/hash 与精确验证。
- Modify `apps/read-worker/src/r2-snapshot.ts` — manifest 驱动读取及最后验证 envelope fallback。
- Create `deploy/vps/` — SHA-pinned Compose、secret template、cron/flock 和操作说明。
- Create `Dockerfile.vps-sync` and `.github/workflows/vps-sync-image.yml` — Alpine production/debug images 与 GHCR 交付。

---

### Task 1.1: PostgreSQL package、migration 与 advisory locks

**Files:**
- Create: `apps/vps-sync/package.json`, `apps/vps-sync/tsconfig.json`, `apps/vps-sync/src/postgres/migrations/0001_initial.sql`；`apps/vps-sync/package.json` 必须包含 `build`（使用经验证的 tsc/tsup 编译到 `dist/`）、`build:check`、`test`（`tsx --test`）和 `typecheck` scripts
- Create: `apps/vps-sync/src/postgres/migrate.ts`, `apps/vps-sync/src/postgres/migrate.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `applyMigrations(pool: Pool): Promise<void>`；`withSessionLock<T>(client: PoolClient, key: bigint, work: () => Promise<T>): Promise<{ acquired: boolean; value?: T }>`；不可变 `schema_migrations(name text primary key, checksum text, applied_at timestamptz)`。

- [x] **Step 1: 验证依赖与 PostgreSQL API** — 执行 `pnpm view pg version`、检查 `node_modules/pg` types，并在临时 PostgreSQL 上执行 `psql --help` 与 `SELECT pg_try_advisory_lock(1);`；把确认的版本和签名记录在实现注释/PR notes。集成测试环境（需先具备 Docker）：本地用 `docker run --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine` 启动 disposable 实例，CI 用 `services: postgres:17-alpine` 加 health check；`DATABASE_URL` 指向该实例，测试结束销毁。启动命令写进 `docs/runbook/vps-data-plane.md`。本地无 Docker 时这些集成测试标记为环境前置，不在本机强制执行。
- [x] **Step 2: 写 RED 测试** — 测试按文件名顺序应用 migration、重复执行 no-op、checksum 改变时报 `MIGRATION_CHECKSUM_MISMATCH`、两个连接仅一个获得相同 session lock。
  ```ts
  await applyMigrations(pool)
  await assert.rejects(() => applyMigrations(poolWithChangedChecksum), /MIGRATION_CHECKSUM_MISMATCH/)
  assert.deepEqual(await Promise.all([claim(a), claim(b)]).then(xs => xs.map(x => x.acquired).sort()), [false, true])
  ```
- [x] **Step 3: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- migrate.test.ts`，预期因 `applyMigrations` 不存在而 FAIL。
- [x] **Step 4: 最小 GREEN + REFACTOR** — 实现 checksum、migration lock、逐文件事务和 schema ahead/behind 拒绝；运行同一测试与 `pnpm -F @airing-cal/vps-sync typecheck`，预期 PASS。
- [x] **Step 5: 文档、提交与推送** — 在 `docs/runbook/vps-data-plane.md` 记录 migration 前置条件与不可逆策略；`git add ... && git commit -m "feat(vps-sync): add PostgreSQL migration runner" && git push`。

### Task 1.2: 规范化 PostgreSQL repositories

**Files:**
- Create: `apps/vps-sync/src/postgres/repositories.ts`, `apps/vps-sync/src/postgres/repositories.test.ts`
- Modify: `apps/vps-sync/src/postgres/migrations/0001_initial.sql`, `docs/runbook/vps-data-plane.md`

**Interfaces:**
- Produces: `PostgresAuthority` methods `beginRun`、`commitCompleteState`、`listDueMedia`、`applyMediaResult`、`getPublicationState`、`savePendingPublication`、`verifyPublication`、`finishRun`；rows use `users/subjects/collection_items/subject_media/calendar_entries/sync_runs/publications`.

- [x] **Step 1: RED tests** — 用真实临时 PG 验证完整 transaction rollback、两次完整 observation 才确认删除、恢复条目取消 missing、旧 `observed_at/run_id` media 写入被拒、pending replay/generation conflict、所有 text/json 列扫描不到测试 secrets。
  ```ts
  await authority.commitCompleteState(firstMissing)
  assert.equal(await authority.collectionExists('u', 1), true)
  await authority.commitCompleteState(secondMissing)
  assert.equal(await authority.collectionExists('u', 1), false)
  ```
- [x] **Step 2: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- repositories.test.ts`，预期因 repository 未定义而 FAIL。
- [x] **Step 3: GREEN** — 增加约束、upserts、删除观察、calendar replace、publication singleton/pending 和 sanitized run persistence；事务中不得发网络请求。
- [x] **Step 4: REFACTOR/验证** — `pnpm -F @airing-cal/vps-sync test -- repositories.test.ts && pnpm -F @airing-cal/vps-sync typecheck` PASS；检查 SQL 参数全部参数化。
- [x] **Step 5: 文档、提交与推送** — 同步 schema/secret 禁存规则；commit `feat(vps-sync): add normalized PostgreSQL authority` 后 push。

### Task 2.1: 完整上游抓取与有界 retry

**Files:**
- Create: `apps/vps-sync/src/upstream/retry.ts`, `apps/vps-sync/src/upstream/retry.test.ts`, `apps/vps-sync/src/upstream/fetch.ts`, `apps/vps-sync/src/upstream/fetch.test.ts`
- Modify: `apps/vps-sync/package.json`, `docs/runbook/vps-data-plane.md`

**Interfaces:**
- Consumes: `BgmClient`、`assembleFullFetch(...)`；`BgmClient` 必须以 `maxGetRetries: 0` 构造以关闭内置 retry，retry 只在 `withRetry` 单层发生。
- Produces: `fetchCompleteInput(config, client, clock): Promise<CompleteFullFetch>`；`withRetry<T>(operation, policy): Promise<T>`；分类码 `auth|not_found|rate_limited|upstream|timeout|network|contract`。

- [x] **Step 1: API 验证** — 在 `docs/example/api/bgm-api.json` 搜索 collection/calendar/detail 端点、method、Bearer mode、limit/offset 与 response schema；再读 `packages/bgm-api/src/bgm-client.ts` 的真实方法签名。
- [x] **Step 2: RED tests** — 覆盖 401/403 一次即失败，429/5xx/timeout/network 最多三次且合法 `Retry-After` 有上限，invalid JSON/schema 终止；primary user/任一分页/calendar 不完整时不返回 `CompleteFullFetch`；断言 429 只触发外层 `withRetry` 的三次尝试，而非 client 内置 retry 与外层叠加。
- [x] **Step 3: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- retry.test.ts fetch.test.ts` 预期 FAIL。
- [x] **Step 4: GREEN/REFACTOR** — 复用 client 和 `assembleFullFetch`，注入 sleep/random 使 jitter 可测，错误只携带 stable code/stage/attempt；局部与 package tests/typecheck PASS。
- [x] **Step 5: 文档、提交与推送** — 同步 retry 表；commit `feat(vps-sync): fetch complete upstream state` 后 push。

### Task 2.2: 一次性 coordinator、run outcomes 与媒体生命周期

**Files:**
- Create: `apps/vps-sync/src/contracts.ts`, `apps/vps-sync/src/media/refresh.ts`, `apps/vps-sync/src/media/refresh.test.ts`, `apps/vps-sync/src/run.ts`, `apps/vps-sync/src/run.test.ts`
- Modify: `apps/vps-sync/src/postgres/repositories.ts`

**Interfaces:**
- Produces: `runOnce(deps, request: { mode:'shadow'|'live'; source:'scheduled'|'manual' }): Promise<RunResult>`；status `success|no_change|partial|failed|skipped`；media result components `detail|metadata|image` with last-known-good semantics。

- [x] **Step 1: RED tests** — 断言 stage 顺序、heartbeat、lock miss 为 skipped 且无上游/R2 写；hard fetch 失败无 authority commit；媒体瞬态失败保留旧引用并发布 partial；404 设置 bounded tombstone；相同图片 bytes 不 PUT；旧 fence 结果不落库。
- [x] **Step 2: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- refresh.test.ts run.test.ts` 预期 FAIL。
- [x] **Step 3: GREEN** — 端口注入 coordinator；图片校验 HTTP/MIME/大小后 SHA-256，先 R2 PUT 再 DB reference；refresh 使用固定并发上限和现有 deterministic staggering/priority。
- [x] **Step 4: REFACTOR/验证** — 将终态派生收敛为纯函数；局部 tests/typecheck PASS，并确认 process exit mapping：success/no_change/skipped=0，partial/failed 非零。
- [x] **Step 5: 文档、提交与推送** — 同步 lifecycle/outcome；commit `feat(vps-sync): coordinate one-shot synchronization` 后 push。

### Task 3.1: Manifest V1、canonical hash 与 generation 规则

**Files:**
- Modify: `packages/domain/src/public-snapshot.ts`, `packages/domain/src/public-snapshot.test.ts`, `packages/domain/src/index.ts`
- Create: `packages/domain/src/public-manifest.ts`, `packages/domain/src/public-manifest.test.ts`

**Interfaces:**
- Produces: `PublicSnapshotManifestV1` 精确字段；`buildManifest(snapshot, metadata)`；`parsePublicSnapshotManifestV1(value)`；`snapshotKey(generation, hash)`；`canonicalSnapshotBytes(snapshot)`；纯函数 `nextSnapshotGeneration(verified, contentHash)`（hash 相同返回 no-op，否则返回 verified generation + 1；未发布时从 1 开始）。数据库并发分配、pending/replay 仍由 Task 3.2 的 publication state machine 负责。

- [x] **Step 1: RED tests** — 精确 keys、ISO UTC、item_count、full git SHA、key/generation/hash 一致；runtime timestamps 不改变 business `content_hash`；相同 content no-op；verified N 的新内容只分配 N+1。新增：`PublicSnapshotV1.published_at` 保持 Unix-second integer 不变；`buildManifest` 的 ISO `published_at` 与该 integer 表示同一时刻；同一 business payload 在不同 wall-clock 时间产生相同 `content_hash`。
- [x] **Step 2: 运行 RED** — `pnpm -F @airing-cal/domain test -- src/public-manifest.test.ts src/public-snapshot.test.ts` 预期 FAIL。
- [x] **Step 3: GREEN** — 基于现有 `sha256Canonical`/`buildPublicSnapshot` 实现 exact parser 与 key grammar，保持 `PublicSnapshotV1` response shape。
- [x] **Step 4: REFACTOR/验证** — domain tests/typecheck PASS；确认导出名与后续 tasks 完全一致。
- [x] **Step 5: 文档、提交与推送** — 在 runbook 写 manifest 示例；commit `feat(domain): define public snapshot manifest` 后 push。

### Task 3.2: S3-compatible R2 原子发布与 replay

**Files:**
- Create: `apps/vps-sync/src/publication/s3.ts`, `apps/vps-sync/src/publication/publish.ts`, `apps/vps-sync/src/publication/publish.test.ts`
- Modify: `apps/vps-sync/package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Produces: `publishSnapshot(ports, candidate, mode): Promise<'published'|'no_change'|'pending'>`；live key `public/manifest.json`，shadow key `shadow/manifest.json`；S3 port `put/get/list/delete`。

- [x] **Step 1: SDK 验证** — 读取本地 AWS SDK types/官方文档确认 endpoint、path style、Put/Get/List/Delete command 与 response body；禁止写入未经验证的 option。
- [x] **Step 2: RED failure-injection tests** — snapshot PUT→GET/parse/hash→manifest PUT→GET/validate→DB verify 的严格顺序；每个 R2 边界失败保留旧 manifest/pending；重跑相同 pending 不跳 generation；shadow 永不写 live key。
- [x] **Step 3: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- publish.test.ts` 预期 FAIL。
- [x] **Step 4: GREEN/REFACTOR** — canonical bytes、conditional conflict 处理和 readback verification；局部 tests/typecheck PASS。
- [x] **Step 5: 文档、提交与推送** — 同步 key/state machine；commit `feat(vps-sync): publish immutable R2 snapshots` 后 push。

### Task 4.1: Read Worker manifest/snapshot 验证切入

**Files:**
- Modify: `apps/read-worker/src/r2-snapshot.ts`, `apps/read-worker/src/r2-snapshot.test.ts`, `apps/read-worker/src/r2-mode-contract.test.ts`, `apps/read-worker/src/health.ts`, `apps/read-worker/src/health.test.ts`, `apps/read-worker/src/index.ts`, `README.md`, `docs/runbook/migrate-public-reads.md`, `docs/runbook/vps-data-plane.md`

**Interfaces:**
- Replaces legacy pointer parsing with `PublicSnapshotManifestV1` at exact R2 key `public/manifest.json`；public routes/query/response remain unchanged。

- [x] **Step 1: RED tests** — valid manifest loads immutable object；未知 schema、extra/missing key、bad timestamp/git SHA/item count/key/hash/truncated JSON 均拒绝；现有 endpoint fixtures 深等于切换前 response。
- [x] **Step 2: 运行 RED** — `pnpm -F @airing-cal/read-worker test -- src/r2-snapshot.test.ts src/read-worker.test.ts` 预期新 manifest cases FAIL。
- [x] **Step 3: GREEN** — 从 R2 binding 读 manifest，复用 domain parsers；不得引入 DB driver/VPS URL/env。
- [x] **Step 4: REFACTOR/验证** — read-worker test/typecheck/build:check PASS。
- [x] **Step 5: 文档、提交与推送** — 同步读路径；commit `feat(read-worker): validate R2 publication manifest`（`bf52e3d`）后 push。

### Task 4.2: R2 → Cache API → legacy KV fallback

**Files:**
- Modify: `apps/read-worker/src/r2-snapshot.ts`, `apps/read-worker/src/r2-snapshot.test.ts`, `apps/read-worker/src/health.ts`, `apps/read-worker/src/health.test.ts`, `README.md`, `docs/runbook/vps-data-plane.md`, `docs/superpowers/specs/2026-08-28-vps-data-plane-migration-design.md`, `openspec/changes/migrate-data-plane-to-vps/design.md`, `openspec/changes/migrate-data-plane-to-vps/specs/public-read-contracts/spec.md`

**Interfaces:**
- Produces Cache API envelope `{ manifest, snapshot }`；只缓存完整验证 pair；source health `r2|cache|legacy`。

- [x] **Step 1: RED tests** — R2 missing/corrupt/offline 用重新验证的 envelope；回退 generation 拒绝；无 envelope 才 legacy；禁止混用 R2 manifest 与 cache/legacy payload。
- [x] **Step 2: 运行 RED** — `pnpm -F @airing-cal/read-worker test -- src/r2-snapshot.test.ts src/health.test.ts` 预期 FAIL。
- [x] **Step 3: GREEN** — cache key 绑定 manifest generation/hash，保存 last-verified envelope，迁移期开启完整 legacy fallback；回滚判断只依赖当前请求可读且重新验证的本地 envelope，Cache API 不提供跨 isolate/POP 原子 fence，不承诺全局单调保证。
- [x] **Step 4: REFACTOR/验证** — read-worker tests/typecheck/build:check PASS。
- [x] **Step 5: 文档、提交与推送** — 同步 health/fallback、README 实际读取契约与 best-effort 回滚保护边界；delta spec/design 明确 Cache API 仅提供本地 envelope fence，跨 isolate/POP 无全局保证；commit `feat(read-worker): add verified snapshot fallback chain` 后 push。

### Task 5.1: custom-format backup、checksum manifest 与 partial outcome

**Files:**
- Create: `apps/vps-sync/src/backup/backup.ts`, `apps/vps-sync/src/backup/backup.test.ts`
- Modify: `apps/vps-sync/src/run.ts`, `apps/vps-sync/src/run.test.ts`, `apps/vps-sync/src/publication/s3.ts` (stream the dump with verified size instead of buffering the full file), `docs/runbook/vps-data-plane.md`

**Interfaces:**
- Produces: `createBackup(deps, run): Promise<BackupResult>`；keys `backups/postgres/YYYY/MM/DD/<timestamp>-<git-sha>.dump|.json`；manifest 包含 schema_version/run_id/git_sha/created_at/object_key/size/sha256。

- [x] **Step 1: CLI 验证** — 优先对目标 Alpine PostgreSQL client 执行 `pg_dump --help`、`pg_restore --help`，确认 custom format、输出和 connection 参数；若工作环境无容器 runtime，则核对对应 PostgreSQL 17 官方 docs/source 与目标镜像 build recipe，并记录未直接运行 help 的限制。实现不得把 URL 放入 argv/log。
- [x] **Step 2: RED tests** — fake command runner 验证 dump→hash/size→dump upload→manifest upload；snapshot published/no_change 后 backup；command/upload 失败使 run partial 且不撤销 publication。
- [x] **Step 3: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- backup.test.ts run.test.ts` 预期 FAIL。
- [x] **Step 4: GREEN/REFACTOR** — bounded `/tmp/airing-cal`、finally cleanup、canonical backup manifest；tests/typecheck PASS。
- [x] **Step 5: 文档、提交与推送** — 同步备份格式；commit `feat(vps-sync): upload verified PostgreSQL backups` 后 push。

### Task 5.2: retention 与安全 restore-verify

**Files:**
- Create: `apps/vps-sync/src/backup/retention.ts`, `apps/vps-sync/src/backup/retention.test.ts`, `apps/vps-sync/src/backup/restore.ts`, `apps/vps-sync/src/backup/restore.test.ts`
- Create: `apps/vps-sync/src/cli.ts` (injectable `runOnce` composition; wire `createBackup` and require a notifier port), `apps/vps-sync/src/cli.test.ts`
- Modify: `docs/runbook/vps-data-plane.md`

**Interfaces:**
- Produces: an injectable composition wires `createBackup` into `runOnce` for `published`/verified `no_change` outcomes and requires a caller-supplied notifier (no default/no-op); it does not activate an executable `sync` command. `selectBackupDeletions(entries: readonly string[] | null): string[]` only returns candidate keys and never issues R2 deletes: retain the latest complete restore point for each of the newest 30 UTC dates, then the latest complete restore point per earlier calendar month; null/list uncertainty or malformed/unpaired keys return no candidates. `restoreVerify(deps, key, targetUrl): Promise<RestoreReport>` receives the target URL by injection, rejects a non-empty target or the production database identity before `pg_restore`, and does not define CLI/env input syntax in this task. Rebuild every database-backed snapshot field from the restored DB; the immutable snapshot named by restored `publications.verified`, after snapshot/hash/key validation, may provide only PostgreSQL-external weekday display labels and stable array ordering/identity indexes needed to reproduce the historical canonical hash. Baseline business values must be overwritten by DB projections, and missing, extra, or mismatched identities fail closed.

- [x] **Step 1: RED tests** — 跨月、同日多份、最近 30 个 UTC 日期、非法/不成对 key 与 list uncertainty；注入式组合要求调用者提供 notifier，将 `createBackup` 接入 `runOnce` 并覆盖 published/no_change 与 partial 失败语义；list uncertainty 时不返回候选且不调用 R2 Delete；target 非空或与 production 具有相同 database identity（即使凭据不同）均在 pg_restore 前失败；恢复后校验 migration、row counts 与 regenerated snapshot hash，weekday labels 与历史数组 ordering/identity indexes 仅从与 restored `publications.verified` 匹配且通过 snapshot/hash/key 校验的 immutable R2 snapshot 取得，所有 DB-backed 字段必须由 DB 重建并覆盖 baseline 值；baseline 缺失、额外/缺失身份或不匹配时 fail closed。
- [x] **Step 2: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- cli.test.ts retention.test.ts restore.test.ts` 预期 FAIL。
- [x] **Step 3: GREEN** — retention 纯函数只返回成对、有效的待审查候选 key，不调用 R2 Delete；注入式组合 `runOnce` 与 `createBackup` 并要求调用者提供真实 notifier，不启用 executable `sync` command；restore 下载并校验 checksum，再向明确空且非 production 的库执行 verified `pg_restore` flags。重建 snapshot 时，baseline 只补 PostgreSQL 未保存的 weekday labels 和历史数组 ordering/identity indexes，collection/calendar/summary/item 等 DB-backed 值全部由恢复数据库投影；验证 regenerated hash 与 baseline publication 一致，身份缺失/额外、baseline 缺失或不匹配则 fail closed。恢复流程绝不 publish/notify user data。Restore command 的凭据入口与可执行包装留到 Task 9.3；任何实际 R2 对象删除需另行批准的 OpenSpec change。
- [x] **Step 4: REFACTOR/验证** — backup/CLI/restore suite、typecheck 与 build:check PASS；显式测试 production URL 规范化比较。
- [x] **Step 5: 文档、提交与推送** — 记录已实现的注入式 restore-verification 接口与安全门，不描述尚未实现的操作命令；Task 9.3 再定义并验证 restore drill 命令及凭据入口；commit `feat(vps-sync): retain and verify PostgreSQL backups` 后 push。

### Task 6.1: 飞书 payload 与签名

**Files:**
- Create: `apps/vps-sync/src/notification/feishu.ts`, `apps/vps-sync/src/notification/feishu.test.ts`, `apps/vps-sync/src/notification/redact.ts`

**Interfaces:**
- Produces: `buildFeishuMessage(result, previousFailure?)`；`signFeishu(timestamp, secret)`；五种 status payload，无 raw exception/secrets。

- [x] **Step 1: 官方契约验证** — 查飞书自定义机器人官方文档，确认 webhook body、timestamp/sign 算法、有效时间窗和成功 response；将链接/访问日期写入 runbook reference。
- [x] **Step 2: RED tests** — success/no_change/partial/failed/skipped 都含 run/mode/source/time/generation/hash/count/duration/backup/git/node/alpine；固定 timestamp/secret 的签名 golden；错误串中的 URL/token/header 被替换。
- [x] **Step 3: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- feishu.test.ts` 预期 FAIL。
- [x] **Step 4: GREEN/REFACTOR** — 只接收 sanitized `RunResult`，Asia/Shanghai 使用 `Intl.DateTimeFormat`，不安装 tzdata；tests/typecheck PASS。
- [x] **Step 5: 文档、提交与推送** — 同步消息字段；commit `feat(vps-sync): build signed Feishu run messages` 后 push。

### Task 6.2: 飞书投递与 notification_failed persistence

**Files:**
- Create: `apps/vps-sync/src/notification/deliver.ts`, `apps/vps-sync/src/notification/deliver.test.ts`
- Modify: `apps/vps-sync/src/run.ts`, `apps/vps-sync/src/postgres/repositories.ts`
- Modify: `apps/vps-sync/src/cli.ts`, `apps/vps-sync/src/cli.test.ts`

**Interfaces:**
- Produces: `deliverNotification(config, result): Promise<'sent'|'failed'>`；独立 `notification_failed` 状态和前次未投递摘要；将真实 Feishu notifier 注入 `cli.ts` 并提供 process-facing、可注入的 executable `sync` entrypoint（不得使用 no-op notifier）。本仓库当前没有完整 PostgreSQL/BGM/R2 runtime composition；无注入 runtime 时入口必须 fail closed，完整生产 composition 留给部署/切换阶段。

- [x] **Step 1: RED tests** — bounded timeout/non-2xx/invalid success body 为 failed；业务终态先持久化；通知失败不改变 publication/backup；下一次成功消息含前次 compact summary；日志无 webhook/signature/DB URL。
- [x] **Step 2: 运行 RED** — `pnpm -F @airing-cal/vps-sync test -- deliver.test.ts run.test.ts repositories.test.ts` 预期 FAIL。
- [x] **Step 3: GREEN** — 注入 fetch/clock，投递一次且失败不抛过业务边界，repository 独立记录结果；用真实 `deliverNotification` 组合并提供 process-facing、可注入的 executable `sync` entrypoint；无 runtime composition 时 fail closed，不实现 no-op 或越界重建生产适配器。
- [x] **Step 4: REFACTOR/验证** — notification/run suites/typecheck PASS。
- [x] **Step 5: 文档、提交与推送** — 同步 secret 与失败语义；commit `feat(vps-sync): deliver terminal Feishu notifications` 后 push。

### Task 7.1: Alpine production/debug images

**Files:**
- Create: `Dockerfile.vps-sync`, `.dockerignore`, `scripts/verify-vps-sync-image.mjs`, `scripts/verify-vps-sync-image.test.mjs`
- Modify: `apps/vps-sync/package.json`

**Interfaces:**
- Targets: `production` 与 `debug`；CLI entry executes compiled `apps/vps-sync`；production user non-root；Dockerfile 的 build stage 调用 `pnpm -F @airing-cal/vps-sync build`，production stage 只拷贝 `dist/` 与 production dependencies。

- [x] **Step 1: image/package 验证** — `docker buildx imagetools inspect node:alpine` 确认架构/digest；在临时 `node:alpine` 容器运行 `apk search` 验证 CA、PostgreSQL client 和 debug HTTPS/DNS/TCP/process/network/JSON 包名；`docker buildx build --help` 验证 flags。当前环境无 Docker，已记录未直接执行的限制及复核命令。
- [x] **Step 2: RED verifier** — 测试 production 不含 git/curl/python/editor/jq/DNS/build toolchain/source/tests/dev dependencies，uid 非 0、无监听端口；debug 含经验证工具。
- [x] **Step 3: 运行 RED** — `node --test scripts/verify-vps-sync-image.test.mjs`，预期 Dockerfile/targets 缺失而 FAIL。
- [x] **Step 4: GREEN** — multi-stage deps/build/production/debug；production 仅 compiled app、prod deps、CA、最小 PG client/runtime；清缓存；build 与 verifier PASS。
- [x] **Step 5: 文档、提交与推送** — 记录 resolved versions/digest 检查法；commit `build(vps-sync): add minimal Alpine images` 后 push。

### Task 7.2: SHA-pinned Compose、secrets、tmp 与 host cron

**Files:**
- Create: `deploy/vps/compose.yaml`, `deploy/vps/.env.example`, `deploy/vps/run-sync.sh`, `deploy/vps/README.md`, `scripts/validate-vps-compose.mjs`, `scripts/validate-vps-compose.test.mjs`

**Interfaces:**
- Compose requires `VPS_SYNC_IMAGE` 匹配 `^ghcr\.io/skyline-gazer/airing-cal-sync:[0-9a-f]{40}$`；one-shot service uses `init/read_only/user/cap_drop/tmpfs`，无 ports/restart/socket/privileged。

- [x] **Step 1: CLI/config 验证** — `docker compose config --help`、`docker compose run --help`、`flock --help`；确认 Compose keys 后才写文件。当前环境无 Docker/Compose/flock，已用官方 CLI/Compose/util-linux 文档核对并记录限制。
- [x] **Step 2: RED tests** — floating/latest/debug/short SHA 被 validator 拒绝；valid full SHA passes；rendered config 无端口、restart、privileged、Docker socket，且 `/tmp/airing-cal` 可写。
- [x] **Step 3: 运行 RED** — `node --test scripts/validate-vps-compose.test.mjs` 预期 FAIL。
- [x] **Step 4: GREEN** — Compose/env template；`run-sync.sh` 用非阻塞 host flock 执行 `docker compose run --rm sync sync --mode=... --source=scheduled`，不输出 secrets。
- [x] **Step 5: 验证、文档、提交与推送** — `docker compose --env-file deploy/vps/.env.example -f deploy/vps/compose.yaml config` 与 tests PASS；commit `ops(vps-sync): add pinned one-shot VPS deployment` 后 push。实际 Compose render 因工具缺失未执行，已记录复核命令。

### Task 8.1: GHCR production image CI

**Files:**
- Create: `.github/workflows/vps-sync-image.yml`, `scripts/validate-vps-image-workflow.mjs`, `scripts/validate-vps-image-workflow.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Push builds production after tests and publishes immutable full `${GITHUB_SHA}` plus non-authoritative discovery tag；records Node/Alpine/base digest/pnpm/git metadata；never SSH/deploys。CI 的 `setup-node` 大版本必须与构建时 `node:alpine` 实际解析到的 Node 大版本一致。当前仓库 CI 固定为 Node 24，但浮动 `node:alpine` 跟随 Node Current，两者可能不一致。实施时必须先通过官方 image metadata 或在具备 Docker 的环境中验证实际解析版本，再决定同步升级 `setup-node`，或者改用明确的 `node:<major>-alpine`；不得在计划中预设当前大版本或未经验证的命令输出格式。

- [x] **Step 1: Actions contract 验证** — 读取官方 action README/metadata 与现有 workflows，确认 checkout/setup-buildx/login/metadata/build-push inputs、GHCR permissions、concurrency；所有 action pin 使用已验证 commit SHA。Docker/DNS 不可用，已记录官方文档/commit 页面 fallback。
- [x] **Step 2: RED tests** — workflow parser 断言 test/typecheck/build gates 先于 push、tag 为完整 SHA、无 VPS secrets/SSH、已有 SHA package 不覆盖。
- [x] **Step 3: 运行 RED** — `node --test scripts/validate-vps-image-workflow.test.mjs` 预期 FAIL。
- [x] **Step 4: GREEN** — 添加 workflow 与 metadata artifact/summary；本地 validator、`git diff --check` PASS。
- [x] **Step 5: 文档、提交与推送** — 同步 GHCR 权限/tag/人工部署；commit `ci: publish immutable VPS sync image` 后 push。

### Task 8.2: 手动 debug image 与 production tag isolation

**Files:**
- Modify: `.github/workflows/vps-sync-image.yml`, `scripts/validate-vps-image-workflow.test.mjs`, `scripts/validate-vps-compose.test.mjs`, `deploy/vps/README.md`

**Interfaces:**
- `workflow_dispatch` explicit debug input builds only target `debug` and a tag matching `[0-9a-f]{40}-debug`；production Compose validator rejects it。

- [ ] **Step 1: RED tests** — 普通 push 无 debug build；manual debug 无 production overwrite；debug tag exact；Compose debug ref rejected。
- [ ] **Step 2: 运行 RED** — 两个 validator test files 预期新 cases FAIL。
- [ ] **Step 3: GREEN** — 添加 job condition/target/tag，保留 production immutable enforcement。
- [ ] **Step 4: REFACTOR/验证** — workflow/compose validators 与 `git diff --check` PASS。
- [ ] **Step 5: 文档、提交与推送** — 写人工 debug 构建/禁用于生产；commit `ci: publish manual VPS debug image` 后 push。

### Task 9.1: 用户与运维文档全量同步

**Files:**
- Modify: `README.md`, `docs/runbook/vps-data-plane.md`, `deploy/vps/README.md`
- Create: `docs/architecture/vps-data-plane.md`（`docs/architecture/` 目录当前不存在，需一并新建）

**Interfaces:**
- Documents implemented CLI `sync|migrate|backup|restore-verify`、env、schema、R2 keys、backup/notification、部署/回滚和旧 changes supersession。

- [ ] **Step 1: 文档事实审计** — 从 `cli.ts` config parser、Compose、workflow、SQL migrations、Read Worker routes/log events 提取实际字段；逐项对照 `docs/rules/docs-sync.md`。
- [ ] **Step 2: 写文档契约测试/扫描** — 扩展现有 scripts test 或新增 `scripts/vps-docs.test.mjs`，断言所有 env/commands/events 都在文档且没有未实现内容。
- [ ] **Step 3: 运行 RED** — `node --test scripts/vps-docs.test.mjs` 预期缺文档项 FAIL。
- [ ] **Step 4: GREEN** — 更新四份文档，明确旧 CF changes frozen/superseded、无自动清理/部署；docs test 与 `git diff --check` PASS。
- [ ] **Step 5: 提交与推送** — commit `docs: document VPS data plane operations` 后 push。

### Task 9.2: 全仓验证与 verification report

**Files:**
- Create: `docs/superpowers/reports/2026-08-28-vps-data-plane-migration-build-verify.md`
- Modify: only files required to fix failures, each fix in its own RED/GREEN commit before report commit。

**Interfaces:**
- Report records command、exit code、关键输出、环境边界与未执行的生产 gates；不得把未运行项写成通过。

- [ ] **Step 1: 运行 package/full gates** — `CI=true pnpm test`、`CI=true pnpm typecheck`、`CI=true pnpm build:check`、PostgreSQL integration suite、R2 failure suite、image/Compose/workflow validators。
- [ ] **Step 2: 运行协议/文档 gates** — `pnpm exec openspec validate migrate-data-plane-to-vps --strict`、`git diff --check`、secret scan、README/config/API audit。
- [ ] **Step 3: 修复失败** — 每个失败先添加/保留回归测试，再最小修复、重跑相关与全局 gate，并以独立 conventional commit + push 交付。
- [ ] **Step 4: 写 verification report** — 仅记录新鲜证据；production shadow/restore/cutover 标为需显式环境执行的后续 gate，而非完成。
- [ ] **Step 5: 提交与推送** — commit `docs: record VPS data plane build verification` 后 push。

### Task 9.3: Shadow、restore、cutover 与 rollback 工具门禁

**Files:**
- Create: `apps/vps-sync/src/operations/migration.ts`, `apps/vps-sync/src/operations/migration.test.ts`
- Modify: `apps/vps-sync/src/cli.ts`
- Modify: `docs/superpowers/reports/2026-08-28-vps-data-plane-migration-build-verify.md`, `docs/runbook/vps-data-plane.md`

**Interfaces:**
- Produces 可测试的 `shadow-compare`、`restore-verify`、`cutover`、`rollback` 运维命令/脚本与证据模板；Build 只验证 dry-run/fake 环境，不操作 production manifest、scheduler 或数据库。

- [ ] **Step 1: CLI 契约验证** — 对新增命令和包装脚本逐一运行 `--help`，确认 shadow/live、备份 key、目标数据库和 dry-run 参数；不得写未验证 flag。
- [ ] **Step 2: RED tests** — fake PostgreSQL/R2/Cloudflare control-plane ports 验证 shadow 只写 shadow namespace、compare 输出字段级 diff、restore 拒绝 production/non-empty target、cutover 无 approval token 时拒绝、rollback 只恢复已验证 manifest。
- [ ] **Step 3: 运行 RED** — 运行新增运维命令测试，预期因 command/approval gate 不存在而 FAIL。
- [ ] **Step 4: GREEN/REFACTOR** — 实现命令、证据模板与 runbook；在本地 fake 环境完成三轮 shadow 模拟和一次 restore 模拟，明确真实生产三次运行/七日观察属于 Archive 后的人工 rollout。
- [ ] **Step 5: 提交与推送** — 局部测试、typecheck、`git diff --check` PASS；commit `ops(vps-sync): add guarded migration operations` 后 push。

### Task 9.4: 30 日 legacy 保留与独立清理门禁实现

**Files:**
- Create: `apps/vps-sync/src/operations/cleanup-gate.ts`, `apps/vps-sync/src/operations/cleanup-gate.test.ts`
- Modify: `docs/runbook/vps-data-plane.md`, `docs/superpowers/reports/2026-08-28-vps-data-plane-migration-build-verify.md`

**Interfaces:**
- Produces pure `evaluateLegacyCleanupGate(cutoverAt, now, evidence)` 与只读资源清单模板；resource deletion belongs to a separately approved OpenSpec change。

- [ ] **Step 1: RED tests** — 未满 30 日、七日观察缺失、restore evidence 缺失、rollback dependency 未记录或无独立 change approval 时 gate 必须返回 blocked。
- [ ] **Step 2: 运行 RED** — 运行 cleanup gate tests，预期 evaluator 不存在而 FAIL。
- [ ] **Step 3: GREEN** — 实现纯 gate evaluator 和无 credentials 的 D1/KV/Queue/Workflow/DO/R2 清单 schema；不得实现 delete 调用。
- [ ] **Step 4: 文档/验证** — runbook 明确实际 30 日等待发生在 Archive 后，清理必须新建 OpenSpec change 并重新验证每条删除命令；tests 与 `git diff --check` PASS。
- [ ] **Step 5: 提交与推送** — commit `docs: gate legacy Cloudflare resource cleanup` 后 push。

## Final Acceptance Checklist

- [ ] 20 个 OpenSpec tasks 均有对应 RED/GREEN 证据、原子 commit 和 push；Build 不执行真实生产切流、七日观察、30 日等待或资源删除。
- [ ] 正常公开请求只访问 Frontend/Read Worker、R2 与 Cache API，不访问 VPS/PostgreSQL。
- [ ] Collection/calendar hard failure 不提交、不发布；媒体失败使用 last-known-good 且通知 partial。
- [ ] R2 live manifest 仅在 immutable snapshot readback/hash 验证后切换，失败可 replay 且 generation 不跳号。
- [ ] R2 backup 可恢复至不同的空 PostgreSQL 并重建相同 snapshot hash。
- [ ] Production Alpine image 最小、非 root、只读、无端口；debug 工具隔离在手动 debug image。
- [ ] GHCR production/Compose 只使用 full-SHA immutable image；CI 不连接 VPS。
- [ ] 全仓、OpenSpec strict、文档审计和 verification report 均使用新鲜运行证据。
