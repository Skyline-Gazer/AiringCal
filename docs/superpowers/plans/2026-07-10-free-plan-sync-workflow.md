---
change: adopt-free-plan-sync-workflow
design-doc: docs/superpowers/specs/2026-07-10-free-plan-sync-workflow-design.md
base-ref: 99dc51bf29098e424a0e2e257a225115512f2264
---

# Free Plan Cloudflare Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将长时间同步迁移到 Free Plan 可承受的 Cloudflare Workflow，并让部署、快照发布和媒体刷新分别可靠收敛。

**Architecture:** `SyncWorkflow` 只执行 collections/calendar staging、shadow/live publish、refresh planning 与状态持久化；Media Queue 以 V2 job 异步刷新 subject detail/meta/image/R2；CI/CD 只部署和检查控制面。所有迁移按兼容优先的原子提交进行，schedule 在生产 shadow 验证后单独切换。

**Tech Stack:** TypeScript、Cloudflare Workers/Workflows/KV/R2/Queues、Wrangler 4.100.0、Node test runner、pnpm、GitHub Actions。

## Global Constraints

- bgm.tv collections 必须使用 OpenAPI 允许的 `limit=50`；修改 API 调用前核对 `docs/example/api/bgm-api.json`。
- Workflow 每 step 10 ms CPU、50 个外部 subrequest、输出小于 1 MiB；每天不超过 3,000 steps。
- 用户 token 不得进入 Workflow params、KV、Queue 或 operation log。
- 每个任务先验证 CLI flag/config key/API，再按 Red-Green-Refactor 执行。
- 每个原子任务更新对应文档、保持可部署，并 commit/push 当前 `dev`。

---

### Task 1: 解耦 CI/CD 与业务同步

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/bootstrap-cloudflare.yml`
- Create: `scripts/resolve-cloudflare-resources.mjs`
- Create: `scripts/resolve-cloudflare-resources.test.mjs`
- Modify: `.github/workflows/deploy.yml`
- Modify: `scripts/provision-cloudflare-resources.mjs`
- Modify: `scripts/provision-cloudflare-resources.test.mjs`
- Modify: `packages/worker-common/src/deploy-config.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: 常规 deploy 输出 `kv_namespace_id`，但不创建资源、不触发 sync、不轮询 KV。
- Produces: 手动 bootstrap workflow 负责 KV/R2/Queues 的幂等创建。

- [x] **Step 1: 写失败的部署契约测试**

更新 `deploy-config.test.ts`，断言 `deploy.yml` 仅监听 `dev`、包含顶层 `concurrency` 与 job `timeout-minutes`、不包含 `refresh_cache_after_internal_deploy`/`push-sync-trigger`/业务 KV polling；断言 `ci.yml` 运行 typecheck/test/build，bootstrap 单独调用 provisioning。

- [x] **Step 2: 运行测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/worker-common test`
Expected: FAIL，指出旧 deploy 仍监听 main、仍 provision 并等待业务 sync。

- [x] **Step 3: 实现控制面部署**

拆出 `ci.yml`；为 deploy 增加 `concurrency.group: deploy-cloudflare`、`cancel-in-progress: false` 和各 job timeout；以 `resolve-cloudflare-resources.mjs` 只读查询 KV ID并用 `AbortSignal.timeout(15000)`；删除 refresh job，使 frontend 依赖内部部署与 Workflow describe 检查。

- [x] **Step 4: 验证并发布原子提交**

Run: `CI=true pnpm -F @airing-cal/worker-common test && CI=true pnpm typecheck && CI=true pnpm build:check && git diff --check`
Expected: PASS。更新 README 后 commit `ci: decouple deploy from cache sync` 并 push `dev`。

### Task 2: BGM GET 请求边界与收藏分页

**Files:**
- Modify: `packages/bgm-api/src/bgm-client.ts`
- Modify: `packages/bgm-api/src/utils.ts`
- Modify: `packages/bgm-api/src/bgm-client.test.ts`
- Modify: `docs/example/api/bgm-api.json` only if upstream contract evidence changed; otherwise read-only

**Interfaces:**
- Produces: `fetchAllCollections(client, username, options?)`，默认 50 条分页和 120 秒总预算。
- Produces: GET-only retry helper，写方法沿用单次请求。

- [x] **Step 1: 写 GET retry 与 549 条分页失败测试**

覆盖 401/403 不重试、429/5xx/network/timeout 最多两次重试、Retry-After 上限、POST/PATCH 不重试，以及 total=549 时 offsets 为 `0..500` 共 11 次且 limit 全为 50。

- [x] **Step 2: 运行测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/bgm-api test`
Expected: FAIL，当前 limit 为 30 且无 GET retry。

- [x] **Step 3: 实现最小请求策略**

在 `BgmClient.fetchJson` 中基于 `init.method ?? 'GET'` 选择策略；每次 GET 使用 10 秒 signal，重试 429/5xx/`BgmTimeoutError`/`BgmNetworkError`，写请求只执行一次。`fetchAllCollections` 用 deadline 检查总预算并删除固定 200 ms 页间 sleep。

- [x] **Step 4: 验证并发布原子提交**

Run: `CI=true pnpm -F @airing-cal/bgm-api test && CI=true pnpm typecheck && git diff --check`
Expected: PASS。commit `fix: bound bgm collection requests` 并 push。

### Task 3: 账号 compare/apply 复用结果

**Files:**
- Modify: `apps/sync-worker/src/index.ts`
- Modify: `apps/sync-worker/src/sync-worker.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/sync.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: compare item shape from `compareAccounts`。
- Produces: `/internal/sync/apply` 支持 `items` 最多 5 条，旧 `subject_ids` 最多 5 条且 deprecated。

- [x] **Step 1: 写 apply 输入与零重拉失败测试**

测试 6 条返回 400、5 个 items 直接执行且 `fetchCollections` 调用为 0、旧 subject_ids 仍工作、operation log 先 running 后终态、响应 `Cache-Control: no-store`、KV 与日志不含 token。

- [x] **Step 2: 运行测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/sync-worker test && CI=true pnpm -F @airing-cal/domain test`
Expected: FAIL，当前 apply 仍调用 `executeSync` 重拉 collections。

- [x] **Step 3: 实现有界 apply**

增加 compare item 校验和直接 apply 路径；请求开始即持久化脱敏 running log，finally 更新 ok/partial/error；所有 sync 管理响应覆盖 `no-store`。

- [x] **Step 4: 验证并发布原子提交**

Run: `CI=true pnpm -F @airing-cal/sync-worker test && CI=true pnpm -F @airing-cal/domain test && CI=true pnpm typecheck && git diff --check`
Expected: PASS。更新 API 文档，commit `refactor: reuse account sync comparison items` 并 push。

### Task 4: 缓存生命周期与 Media Queue V2

**Files:**
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/keys.test.ts`
- Modify: `packages/storage/src/index.test.ts`
- Modify: `apps/media-worker/src/index.ts`
- Modify: `apps/media-worker/src/media-worker.test.ts`
- Modify: `apps/media-worker/wrangler.toml`
- Modify: `README.md`

**Interfaces:**
- Produces: `subjectRefreshKey(subjectId)`, `nextSubjectRefreshAt(subjectId, cachedAt)`, `SubjectRefreshState`, `MediaRefreshJobV2`。
- Produces: consumer 使用 `message.retry({ delaySeconds })` 并按 `job_id` 去重。

- [x] **Step 1: 写 refresh key/SWR/consumer 失败测试**

断言 100 个 subject 的刷新时间分散在 6～8 天；重复 job 不重复下载；queued/running/ok/partial/failed 与 image status 分离；503 延迟重试 30/120/300；404/missing source ack。

- [x] **Step 2: 运行测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/storage test && CI=true pnpm -F @airing-cal/media-worker test`
Expected: FAIL，V2 类型、refresh key 和 delay retry 尚不存在。

- [x] **Step 3: 实现 V2 与配置**

保留旧 MediaJob 解析兼容；V2 处理前检查 refresh job_id，写 running，组件完成后写 ok/partial/failed。将 consumer 配置设为 batch 1、timeout 5、concurrency 4、retries 3。

- [x] **Step 4: 验证并发布原子提交**

Run: `CI=true pnpm -F @airing-cal/storage test && CI=true pnpm -F @airing-cal/media-worker test && CI=true pnpm typecheck && CI=true pnpm build:check && git diff --check`
Expected: PASS。更新缓存文档，commit `refactor: add idempotent media refresh lifecycle` 并 push。

### Task 5: 实现无 schedule 的 SyncWorkflow

**Files:**
- Create: `apps/sync-worker/src/workflow.ts`
- Create: `apps/sync-worker/src/workflow.test.ts`
- Create: `apps/sync-worker/src/workflow-types.ts`
- Modify: `apps/sync-worker/src/index.ts`
- Modify: `apps/sync-worker/wrangler.toml`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/keys.test.ts`
- Modify: `apps/sync-worker/worker-configuration.d.ts` via verified Wrangler types command
- Modify: `README.md`

**Interfaces:**
- Produces: exported `SyncWorkflow extends WorkflowEntrypoint<SyncEnv, SyncWorkflowParams>`。
- Produces: `SyncRun`, run/staging/shadow key helpers，`planRefreshJobs(subjectIds, instanceId)`。

- [x] **Step 1: 写 fake-step Workflow 失败测试**

覆盖 549 条 11 页、确定性 step 名、输出小于 1 MiB、Workflow 不请求 `/v0/subjects/*`、401/403 非重试、429/5xx/timeout retry、失败保留旧 snapshot。

- [x] **Step 2: 写 publish/enqueue 失败测试**

覆盖 shadow 正式 key 隔离且零 Queue 消息、live publish、100 个 subject 按 10 规划、每 step API 调用不超过 50、sendBatch 不超过 100、重放 job_id 去重。

- [x] **Step 3: 运行测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/sync-worker test`
Expected: FAIL，Workflow class 和类型不存在。

- [x] **Step 4: 实现 staging、publish、plan、finalize**

每个 `step.do` 写固定 staging key并仅返回 `{ key, count, digest }`；publish 使用 mode 选择 shadow/live；finalize 更新 run 与兼容 `sync:meta`。首发 `[[workflows]]` 不写 schedules，旧 Cron 暂留。

- [x] **Step 5: 验证配置与类型**

先运行 `pnpm exec wrangler types --help` 和 `pnpm exec wrangler deploy --help` 核对命令，再生成类型并执行 dry-run。Run: `CI=true pnpm -F @airing-cal/sync-worker test && CI=true pnpm typecheck && CI=true pnpm build:check`。

- [x] **Step 6: 文档与发布**

记录 shadow trigger/describe/restart/terminate 的已验证命令形态和回退步骤。commit `feat: add shadow sync workflow` 并 push。

### Task 6: 健康状态与 cache cursor pagination

**Files:**
- Modify: `apps/read-worker/src/index.ts`
- Modify: `apps/read-worker/src/read-worker.test.ts`
- Modify: `apps/read-worker/src/collections.test.ts`
- Modify: `apps/frontend-worker/src/frontend-worker.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `/cache?cursor=<opaque>&limit<=100` 返回 `cursor` 与有界 items。
- Produces: `/health` 返回最近 Workflow instance/stage/heartbeat/completion/error 和 stale。

- [x] **Step 1: 写 pagination/stale/并发失败测试**

模拟 KV list cursor；断言 limit 101 被限制或拒绝、单页不读取全部 key、calendar hydration 同时在途读取不超过固定上限、20 分钟未 heartbeat 显示 stale。

- [x] **Step 2: 运行测试确认 RED**

Run: `CI=true pnpm -F @airing-cal/read-worker test && CI=true pnpm -F @airing-cal/frontend-worker test`
Expected: FAIL，当前 cache 展开全部 key，health 只显示 cron。

- [x] **Step 3: 实现 bounded read path**

把 URL 传给 cache handler，向 KV list 透传 limit/cursor；用共享 `mapConcurrent` 或局部有界 mapper hydration；读取 `sync:meta.workflow_instance_id` 和对应 run key并脱敏错误。

- [x] **Step 4: 验证并发布原子提交**

Run: `CI=true pnpm -F @airing-cal/read-worker test && CI=true pnpm -F @airing-cal/frontend-worker test && CI=true pnpm typecheck && git diff --check`
Expected: PASS。更新 endpoint 文档，commit `feat: expose bounded workflow cache health` 并 push。

### Task 7: 生产 shadow、schedule 切换与旧触发清理

**Files:**
- Modify: `apps/sync-worker/wrangler.toml`
- Modify: `apps/sync-worker/src/index.ts`
- Modify: `apps/sync-worker/src/sync-worker.test.ts`
- Delete: `scripts/push-sync-trigger.mjs`
- Delete: `scripts/push-sync-trigger.test.mjs`
- Modify: `scripts/provision-cloudflare-resources.mjs`
- Modify: `scripts/provision-cloudflare-resources.test.mjs`
- Modify: `packages/worker-common/src/deploy-config.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: deployed shadow Workflow and production Cloudflare credentials。
- Produces: Free Plan Worker Cron `0 */4 * * *`，handler 只创建 Workflow instance，无旧业务 Cron 和 sync-trigger consumer。

- [x] **Step 1: 本地 smoke 与生产 shadow**

先核对 `wrangler workflows trigger/instances describe` 帮助，再运行 local smoke；显式创建 `shadow-<commit>`，确认完成、正式 snapshot 未变、Queue 无新 job、step/CPU/output 在预算内。

- [x] **Step 2: 切换 schedule 的失败测试**

更新部署契约，要求 `[triggers].crons = ["0 */4 * * *"]`，禁止 `[[workflows]].schedules`、sync-trigger queue/旧业务 handler/script。

- [x] **Step 3: 原子切换触发源**

启用 Worker Cron 桥接并删除旧业务 Cron；部署后 describe，观察至少一个 live instance 成功更新 snapshot 且 media backlog 收敛。

- [x] **Step 4: 清理旧资源声明**

删除旧 queue handler、脚本与 bootstrap queue name；保留实际 Cloudflare queue 资源到稳定观察完成后再从控制面手动删除。

- [x] **Step 5: 全量文档与验证**

Run: `CI=true pnpm typecheck && CI=true pnpm test && CI=true pnpm build:check && git diff --check`
Expected: PASS。审计 README 的 endpoint、变量、Worker、Workflow、事件、配置、发布和回退说明。

- [x] **Step 6: 最终发布**

commit `release: activate durable sync workflow` 并 push。核对 GitHub Actions、Workflow instance 与 `/api/health` 均正常，无永久 running。

### Task 8: 审计补救——Durable coordination primitives

**Files:** `packages/storage/src/index.ts`、`apps/sync-worker/src/snapshot-coordinator.ts`、`apps/media-worker/src/subject-refresh-coordinator.ts`、对应测试与 Wrangler 配置。

- [x] **Step 1: RED** — 为 generation 幂等分配、T2 先 commit/T1 后 commit、同 subject 旧 generation obsolete 与 legacy generation 0 写失败测试并确认按预期失败。
- [x] **Step 2: GREEN** — 增加 `SnapshotManifest`、`MediaRefreshJobV3`、`sync:current` key 与两个 SQLite Durable Object class/binding/migration；使用本地 types/schema 核对 API 与配置。
- [x] **Step 3: VERIFY** — 运行 storage/sync/media 定向测试、typecheck、Wrangler dry-run 与 diff check；更新 tasks，commit `feat: add durable coordination primitives` 并 push。

### Task 9: 审计补救——Workflow 与 Media generation 协议

**Files:** `apps/sync-worker/src/workflow-core.ts`、`apps/sync-worker/src/workflow.ts`、`apps/media-worker/src/index.ts`、对应测试与文档。

- [x] **Step 1: RED** — 覆盖 version key/enqueue 失败不 commit、旧 Workflow 晚完成 obsolete、新 media job 后旧 retry 不覆盖。
- [x] **Step 2: GREEN** — Workflow 按 initialize → version publish → enqueue V3 → coordinator commit → finalize 执行；Media 全部 subject 副作用进入 coordinator 串行路径。
- [x] **Step 3: VERIFY** — 运行 sync/media/worker-common 定向测试、typecheck/build/diff；更新 tasks，分别按 Workflow 与 Media 原子边界 commit/push。

### Task 10: 审计补救——严格读取与当前运行 health

**Files:** `apps/read-worker/src/index.ts`、对应测试、README。

- [x] **Step 1: RED** — 覆盖 active 缺 key/digest 返回 503 且不 legacy fallback、initialize 即可见、21 分钟后 workflow/cron 同时 stale。
- [x] **Step 2: GREEN** — 实现严格 manifest 读取、`sync:current` 定位与唯一 effective status。
- [x] **Step 3: VERIFY** — 运行 read/frontend 定向测试、typecheck/build/diff；更新文档与 tasks，commit `fix: enforce strict snapshot and health contracts` 并 push。

### Task 11: 审计补救——不可变部署、Cron 配额与回退

**Files:** `.github/workflows/deploy.yml`、部署契约测试、Cron preflight script/tests、README。

- [x] **Step 1: RED** — 覆盖非 `dev` ancestor ref 拒绝、所有 job 使用同一 SHA、配额不足时 deploy 前失败、footer SHA 等于 checkout HEAD。
- [x] **Step 2: GREEN** — 增加无 secrets `resolve_ref`、唯一 SHA output、部署前 quota preflight、失败恢复输出与正式 rollback runbook。
- [x] **Step 3: VERIFY** — 运行部署配置测试与全量 `pnpm test`、`pnpm typecheck`、`pnpm build:check`、`git diff --check`、`pnpm audit --prod`；完成 thorough review 和生产 shadow/smoke 后更新 tasks 并原子 commit/push。
