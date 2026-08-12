---
change: harden-workflow-request-budget
design-doc: docs/superpowers/specs/2026-08-12-harden-workflow-request-budget-design.md
base-ref: 60d8e97
---

# Workflow 请求预算硬化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把任意规模 collections/calendar/prepare/refresh 同步拆成可重放的 Workflow continuation，使任一 Worker invocation 都不会耗尽 Cloudflare Free Plan 的外部或内部 subrequest 预算，并且失败能可靠留下终态记录。

**Architecture:** 在 `workflow-core.ts` 中把一次性顺序执行改为 V1 manifest 驱动的状态机：manifest 是 instance staging 唯一的进度来源，版本化 step 名只缓存确定性组结果。每个 invocation 创建分离的 external/internal `InvocationBudget`；组在副作用前预留 manifest/run-state 写入和 terminal continuation 的容量，达到边界后先持久化再 `step.sleep`。prepare 只接受完整、经 digest/hash 验证的 manifest，live refresh 与终态写入使用同一内部预算边界，旧实例仍走旧 step 前缀。

**Tech Stack:** TypeScript、Cloudflare Workers Workflows、KV、Durable Object、D1、R2、Queues、Node test runner、pnpm、Wrangler 4.x、OpenSpec。

## Global Constraints

- 实施前必须用 `pnpm exec wrangler --help`、`apps/sync-worker/worker-configuration.d.ts` 和当前 Cloudflare 官方文档核实所有 Free Plan 限额、`WorkflowStep.sleep` 签名与新 API；不得把未经核实的数字、flag 或 API 写入代码或文档。
- 修改任何 bgm.tv 调用前，先核对 `docs/example/api/bgm-api.json` 中 collections 与 calendar 的路径、method、认证和 `limit=50`；不得新增端点或改变 token 传递方式。
- `BANGUMI_USERS` 不设上限；每一页都必须取得，不能以截断、跳过或仅处理首用户规避预算。
- token、原始上游响应体、完整上游错误不得进入 Workflow params、manifest、KV、Queue、step output 或观测记录；错误只能用 `sanitizeErrorMessage` 后的分类文本。
- 只有已验证的 collections 全页和 calendar 均完整时，才可调用 `assembleFullFetch`、执行删除判断、D1/R2 publication 或提交 live snapshot；任何不完整/损坏输入必须保留旧正式 snapshot。
- `run.started_at` 是 planner 的唯一时间基准；sleep、Workflow replay 与 step retry 不得改变候选、reservation ID 或 `job_id`。
- shadow 继续零 Queue 副作用且不写共享 latest pointer；legacy public read、media budget 与 Queue V3 payload 契约不变。
- 每个原子任务依次执行 RED → GREEN → focused regression → `git diff --check`，更新涉及的文档，并立即以 conventional commit 提交和 `git push origin dev`。
- 在 build 前读取 `openspec/changes/harden-workflow-request-budget/.comet.yaml`，确认 `phase: build`、proposal/design/tasks/design_doc 齐全；每任务通过双审后才勾选对应 `tasks.md` 项。

## Planned File Structure

- Modify: `apps/sync-worker/src/workflow-core.ts` — V1 continuation manifest、budget ledger、版本化 stages、终态边界与现有发布逻辑的集成点。
- Modify: `apps/sync-worker/src/workflow.ts` — 若 `WorkflowStepLike` 的 verified `sleep` 适配需要由入口转换，在这里保持 Cloudflare 类型边界。
- Modify: `apps/sync-worker/src/workflow.test.ts` — invocation-aware fake Workflow、预算计数、sleep/replay、多用户大分页、终态与兼容回归。
- Modify: `apps/sync-worker/src/full-fetch-boundary.ts` — manifest 驱动组在交给 `assembleFullFetch` 前的 schema、页唯一性和 aggregate digest 验证。
- Modify: `apps/sync-worker/src/full-fetch-boundary.test.ts` — 完整性、重复页、hash/schema 损坏的 fail-closed 单元测试。
- Modify: `README.md` — 仅在实现完成后记录已验证的运行观测、恢复和回滚操作；不得写前瞻内容。
- Modify: `docs/superpowers/specs/2026-08-12-harden-workflow-request-budget-design.md` — 实现落地后同步常量来源、stage/manifest 契约与运维证据。
- Modify: `openspec/changes/harden-workflow-request-budget/tasks.md` — 每个已通过双审、已提交的任务才勾选。

---

### Task 1: 建立经过验证的 invocation 预算和可休眠测试框架

**Files:**
- Modify: `apps/sync-worker/src/workflow-core.ts:45-115`
- Modify: `apps/sync-worker/src/workflow.ts:1-15`
- Modify: `apps/sync-worker/src/workflow.test.ts:111-145`

**Interfaces:**
- Produces: `export type RequestClass = 'external' | 'internal'`、`export interface InvocationBudget { readonly limits: Readonly<Record<RequestClass, number>>; readonly used: Record<RequestClass, number>; reserve(requests: Readonly<Record<RequestClass, number>>, reason: string): void; remaining(requestClass: RequestClass): number }`。
- Produces: `export interface WorkflowStepLike { do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>; sleep(name: string, duration: string): Promise<void> }`，其中 `duration` 只在确认 Cloudflare 类型后采用实际类型。
- Produces: `BUDGET_V1`（外部、内部、continuation 写入、terminalization 的已核实成本/余量）和 `BudgetExhaustedError`；任何受管调用必须在副作用前 `reserve`。
- Consumes: Cloudflare Workflow type declaration、`pnpm exec wrangler --help` 与官方限额证据；现有 `MockKV`/`FakeStep`。

- [ ] **Step 1: 核实限额与 Workflow API，再记录可追溯证据**

Run:

```bash
pnpm exec wrangler --help
rg -n "interface WorkflowStep|class WorkflowStep|sleep\(" apps/sync-worker/worker-configuration.d.ts
rg -n '"/v0/users/\{username\}/collections"|"/calendar"|"limit"|"Bearer"' docs/example/api/bgm-api.json
```

Expected: 本地输出能确认实际 Wrangler 命令、Workflow `sleep` 的参数类型，OpenAPI 仍证明 collections 的 `limit=50` 与现有 calendar 调用合法。若任何项不能证明，停止并查官方 Cloudflare 文档后把 URL、访问日期与数值写入本任务提交的设计文档证据段。

- [ ] **Step 2: 写预算与 hibernate/resume 的失败测试**

在 `workflow.test.ts` 将 `FakeStep` 扩展为按 invocation 记录 `do`、KV 和 coordinator 调用，并加入一个显式 `sleep(name, duration)` 记录：

```ts
test('InvocationBudget rejects a side effect before either limit is exceeded', () => {
  const budget = createInvocationBudget({ external: 2, internal: 5 })
  budget.reserve({ external: 2, internal: 4 }, 'collection-group')
  assert.throws(() => budget.reserve({ external: 1, internal: 0 }, 'calendar'), /external budget/i)
  assert.deepEqual(budget.used, { external: 2, internal: 4 })
})

test('fake Workflow resumes after sleep with a fresh invocation ledger', async () => {
  const step = new FakeStep()
  await step.sleep('sync-v1-yield-0', '1 second')
  assert.equal(step.invocations.length, 2)
  assert.equal(step.invocations[0]!.sleeps[0]!.name, 'sync-v1-yield-0')
})
```

测试 fake 必须把 replay step output 与“新 invocation 计数归零”分开：已缓存 `step.do` 不重跑 callback，但 continuation 之后的 callback 必须归入新的 invocation。

- [ ] **Step 3: 运行 RED 测试**

Run: `CI=true pnpm -F @airing-cal/sync-worker test -- workflow.test.ts`

Expected: FAIL，报 `createInvocationBudget`/`sleep` 尚不存在或 fake 无 invocation ledger；不得因改测试绕开失败。

- [ ] **Step 4: 实现最小 typed ledger 与 verified sleep 适配**

在 `workflow-core.ts` 添加无 I/O 的 budget factory，常量命名为 `WORKFLOW_BUDGET_V1_*`；`reserve` 先验证所有 request class，再一次性递增 `used`，使失败不会留下半记账。将 `getJson`、`putJson`、`writeRun`、`coordinatorRequest` 改为接受可选 `budget` 和明确的 `{ external, internal }` 成本；先 reserve 再执行现有副作用。不要把 `BgmClient` 封装成新网络客户端，也不要更改 URL、header 或 token。

将 `WorkflowStepLike` 加上经 Step 1 核实的 `sleep`，并在 `workflow.ts` 仅做已确认的类型适配。保留旧 step 名路径，后续 Task 才调用 `sleep`。

- [ ] **Step 5: 运行 GREEN 与类型检查**

Run:

```bash
CI=true pnpm -F @airing-cal/sync-worker test -- workflow.test.ts
CI=true pnpm -F @airing-cal/sync-worker typecheck
git diff --check
```

Expected: PASS；预算耗尽发生在 mock KV/coordinator 记录新调用之前，且 fake 能展示一次 continuation 后独立计数。

- [ ] **Step 6: 提交预算基础**

```bash
git add apps/sync-worker/src/workflow-core.ts apps/sync-worker/src/workflow.ts apps/sync-worker/src/workflow.test.ts docs/superpowers/specs/2026-08-12-harden-workflow-request-budget-design.md
git commit -m "refactor(sync): add typed workflow request budget"
git push origin dev
```

Expected: commit 与 push 成功；本 task 尚不勾选 OpenSpec，等待双审。

### Task 2: 以 V1 manifest 将 collections、calendar 和 prepare 拆为安全 continuation

**Files:**
- Modify: `apps/sync-worker/src/workflow-core.ts:92-420`
- Modify: `apps/sync-worker/src/full-fetch-boundary.ts:1-170`
- Modify: `apps/sync-worker/src/workflow.test.ts:280-560`
- Modify: `apps/sync-worker/src/full-fetch-boundary.test.ts:1-220`

**Interfaces:**
- Consumes: `InvocationBudget`、`syncStagingKey(instanceId, suffix)`、`assembleFullFetch`。
- Produces: `export interface FetchContinuationManifestV1 { version: 1; instance_id: string; started_at: number; phase: 'collections' | 'calendar' | 'prepare' | 'publish'; users: Array<{ user_id: string; total: number | null; next_page: number; pages: Array<{ page: number; offset: number; key: string; count: number; digest: string }> }>; calendar: { key: string; count: number; digest: string } | null; aggregate_hash: string | null }`。
- Produces: `fetchManifestKey(instanceId): string` using `syncStagingKey(instanceId, 'fetch-manifest:v1')`; `readFetchManifestV1`, `validateFetchManifestV1`, `writeFetchManifestV1` reject foreign IDs, invalid phase, duplicate/gapped pages, bad digest/count and non-frozen time.
- Produces: versioned step names `sync-v1-fetch-collections-u{userIndex}-p{page}` and `sync-v1-fetch-calendar`; an exhausted group writes the manifest then executes `step.sleep('sync-v1-yield-fetch-{cursor}', verifiedDuration)`.

- [ ] **Step 1: 写 manifest schema、replay 和完整性失败测试**

在 `full-fetch-boundary.test.ts` 增加最小 manifest fixture，并覆盖：同一 `(user,page)` 重复、页号跳跃、manifest instance 不匹配、digest 不匹配、calendar 缺失与 aggregate hash 不一致都抛出 fail-closed 错误。测试使用明确值：

```ts
assert.throws(() => validateFetchManifestV1({ ...manifest, users: [{ ...manifest.users[0]!, pages: [page0, page0] }] }), /duplicate page/i)
assert.throws(() => materializeFullFetchFromManifest(manifestWithoutCalendar, kv, 123), /incomplete calendar fetch/i)
```

在 `workflow.test.ts` 添加两用户、总 collections 页数超过已核实 external group 容量的 fixture，断言：(a) 每个 invocation 的 external/internal 计数都 `<= BUDGET_V1`，(b) sleep 前写入 manifest，(c) resume 后仅 fetch 缺失页，(d) 完成后两用户页全存在，(e) 50+ 页时仍不进入 publish 前 prepare。

- [ ] **Step 2: 运行 RED 测试**

Run:

```bash
CI=true pnpm -F @airing-cal/sync-worker test -- workflow.test.ts full-fetch-boundary.test.ts
```

Expected: FAIL，当前 workflow 一次性 fetch 所有页、无 manifest 与 sleep，且不存在 materialize/validate 函数。

- [ ] **Step 3: 先实现 manifest parse/validate/materialize，再实现 fetch continuation**

将 `CollectionFetchGroup` 的构造集中到 `materializeFullFetchFromManifest(manifest, kv, expectedInstanceId)`；它按 users 和 page 升序读 `page.key`，核验每页 `digest`，然后传给现有 `assembleFullFetch`。只在 `manifest.calendar !== null` 且 aggregate hash 匹配时读 calendar。任何 `null`、错误类型、重复、总数漂移、hash 不同都 throw；不可使用 `?? []` 将缺失数据转成成功空列表。

将当前 `for users` fetch 循环替换为 V1 fetch runner：首次初始化写 `started_at` 到 manifest；第一页发现 `total` 后更新该用户 `total/next_page`；每成功一页先写 staging page，再把 immutable page summary 写回 manifest。每组先 `budget.reserve` 页 fetch、staging put、manifest put、run heartbeat 与 sleep/terminal 预留；不够则只写 manifest、更新 run stage、`sleep`，绝不发起下一 fetch。已经存在的 manifest 页或已缓存 versioned step 必须返回已有 summary，不能重复网络/KV 写。

calendar 仅在所有 user pages 完整时运行，使用独立 external group；calendar 成功也先写 staging/manifest。随后 `prepare-snapshot-inputs-v1` 从 manifest materialize，且只在 `complete === true` 后生成现有 snapshot/refresh/complete-input keys。保留现有 output key 形状，降低后续 publish/D1 调用面的变更。

- [ ] **Step 4: 运行 GREEN、边界和回归测试**

Run:

```bash
CI=true pnpm -F @airing-cal/sync-worker test -- workflow.test.ts full-fetch-boundary.test.ts
CI=true pnpm -F @airing-cal/sync-worker typecheck
git diff --check
```

Expected: PASS；大分页与多用户完成但没有单次超预算；重放不增加 fetch/staging；不完整、坏 hash 或 calendar 失败时旧 `snapshot:active` 不变，D1/R2/Queue 未被调用。

- [ ] **Step 5: 提交 durable fetch 边界**

```bash
git add apps/sync-worker/src/workflow-core.ts apps/sync-worker/src/full-fetch-boundary.ts apps/sync-worker/src/workflow.test.ts apps/sync-worker/src/full-fetch-boundary.test.ts docs/superpowers/specs/2026-08-12-harden-workflow-request-budget-design.md
git commit -m "feat(sync): continue collection fetches across budgets"
git push origin dev
```

### Task 3: 将 refresh、publish 与终态写入接入统一内部预算边界

**Files:**
- Modify: `apps/sync-worker/src/workflow-core.ts:420-760`
- Modify: `apps/sync-worker/src/workflow.test.ts:560-1340`

**Interfaces:**
- Consumes: prepared V1 complete input、`InvocationBudget`、`run.started_at`、现有 `selectRefreshCandidates`/`planSubjectRefresh`/`coordinatorRequest`。
- Produces: `runBudgetedStage<T>(args: { step: WorkflowStepLike; budget: InvocationBudget; stepName: string; costs: Readonly<Record<RequestClass, number>>; continuation: { name: string; duration: string } | null; callback: () => Promise<T> }): Promise<T | null>`；`null` 表示 manifest/run 已持久化并已 sleep，调用者从 durable state 继续。
- Produces: versioned `sync-v1-plan-refresh-{group}`、`sync-v1-reserve-media`、`sync-v1-commit-live-snapshot`、`sync-v1-finalize`、`sync-v1-record-error` step names；旧 running instance 不请求这些新 step names。
- Produces: dedicated terminalization continuation that writes `SyncRun.status: 'error'`, sanitized error and `sync:meta` only with a fresh terminal budget; terminal failure is retryable and never fabricates `ok`.

- [ ] **Step 1: 写 refresh 切组和终态失败测试**

在 `workflow.test.ts` 使用至少 551 个 subject 的 prepared input 与多 invocation fake，覆盖：

```ts
assert.equal(result.status, 'ok')
assert.equal(new Set(queueMessages.map((job: any) => job.job_id)).size, queueMessages.length)
assert.ok(step.invocations.every((invocation) => invocation.internalCalls <= WORKFLOW_BUDGET_V1_INTERNAL))
assert.deepEqual(plannerOutputsBeforeResume, plannerOutputsAfterReplay)
```

再覆盖四个错误路径：(1) page 最终失败，(2) manifest hash 被替换，(3) 最后一笔普通预算消耗后 `writeRun` 失败，(4) `record-error` 第一次临时失败。断言都不 commit/publish 部分 snapshot，且最终存在 `sync:run:<instance>`，状态为 `error`、不是 `running`，错误不含 token。

同时保留/增强现有 shadow、legacy read、ambiguous queue reservation 与 frozen planner-time 回归：sleep/replay 前后 `candidate`、`${instanceId}:${subjectId}` job ID、`${instanceId}:media` reservation ID 相同。

- [ ] **Step 2: 运行 RED 测试**

Run: `CI=true pnpm -F @airing-cal/sync-worker test -- workflow.test.ts`

Expected: FAIL，当前所有 refresh chunk 仍在一个 invocation，且 catch 在已耗尽的 invocation 中直接执行 `record-error`。

- [ ] **Step 3: 实现内部阶段 continuation 与专用 terminalization**

将 refresh 规划改为从 `prepared.refreshInputKey` 与 manifest/staging cursor 恢复的 bounded groups；每组预算显式包含 refresh-input read、每 subject 的四个 KV reads、候选 staging put、manifest/run put、sleep/terminal reservation。完成组才返回 candidates；跨 sleep 时用 staging 输出和 cursor 重建 selection，不在内存累加。

所有 planner 调用传入 `run.started_at`，删除 planner 路径上的 `nowSeconds()`。selection、reservation、commit、daily shadow、finalize 各成为独立、有 preflight reserve 的 versioned stage。reservation 在 sleep/replay 后重用相同 reservation ID 和 jobs；commit 沿用现有 coordinator idempotency；shadow 分支不得调用 `MEDIA_QUEUE.sendBatch`。

将顶层 catch 改为分类并写入 terminal manifest/state，再 `sleep`/触发独立 `sync-v1-record-error` step；该 step 在自己的 fresh ledger 中 reserve run/meta 写入的完整成本。若 terminal step 本身失败，抛出以便 Workflow retry，不能覆盖原错误、不能把 run 标为 `ok` 或删除 staging。

- [ ] **Step 4: 运行 GREEN 与现有 workflow 回归集**

Run:

```bash
CI=true pnpm -F @airing-cal/sync-worker test -- workflow.test.ts
CI=true pnpm -F @airing-cal/read-worker test
CI=true pnpm -F @airing-cal/sync-worker typecheck
git diff --check
```

Expected: PASS；551 subject、多用户、50+ page 和每种失败都满足 budget/终态断言；Read health 仍能读取 sanitized 非 running state；既有 shadow 与 legacy tests 不变。

- [ ] **Step 5: 提交安全 refresh/terminal 边界**

```bash
git add apps/sync-worker/src/workflow-core.ts apps/sync-worker/src/workflow.test.ts apps/read-worker/src/read-worker.test.ts docs/superpowers/specs/2026-08-12-harden-workflow-request-budget-design.md
git commit -m "fix(sync): reserve workflow terminal request budget"
git push origin dev
```

### Task 4: 兼容性收口、文档和全仓验证

**Files:**
- Modify: `apps/sync-worker/src/workflow-core.ts`
- Modify: `apps/sync-worker/src/workflow.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-12-harden-workflow-request-budget-design.md`
- Modify: `openspec/changes/harden-workflow-request-budget/tasks.md`

**Interfaces:**
- Consumes: V1 manifest/state machine、existing `SyncRun` schema、read-worker health parser、Daily shadow APIs。
- Produces: backward-compatible `SyncRun` observation (optional bounded continuation position/counters only after strict schema validation); README runbook commands whose syntax is verified with `--help`; completed OpenSpec task checkboxes.

- [ ] **Step 1: 写旧实例与观测兼容的失败测试**

新增一个 fake step cache 仅含旧 `fetch-collections-page-*`、`plan-refresh-*` 名的实例，断言恢复不试图把它解释成 V1 manifest，也不重复 collection fetch。为 `sync:run:<instance>` 写入带未知 continuation 字段的记录，断言 health 忽略未知/坏字段而仍显示安全 status/stage；写入 token-shaped error，断言响应不泄漏。

- [ ] **Step 2: 运行 RED 测试**

Run:

```bash
CI=true pnpm -F @airing-cal/sync-worker test -- workflow.test.ts
CI=true pnpm -F @airing-cal/read-worker test
```

Expected: FAIL，直到 V1/legacy 分流和严格观测 schema 都明确实现。

- [ ] **Step 3: 实现兼容分流并完成文档同步**

以 instance 的 versioned manifest/step-prefix 判定新拓扑；缺少 V1 manifest 的历史实例只读取原有 step output/状态，绝不假装完成或混写 V1 key。只把整数计数、version、phase/cursor 和已脱敏错误加入 run/meta，read-worker 继续 reject 非法类型与 secret-shaped text。

更新 README 和设计文档，记录实际核实的限制来源、manifest key/version、health 可见字段、manual shadow 验证、Workflow inspect/retry/rollback 命令及“回滚不删除 KV/D1/R2/Queue/staging”。每条命令先执行相应 `--help`，并仅记录输出存在的参数。不要记录未实际部署/验证的生产成功结论。

- [ ] **Step 4: 执行完整门禁和 materialized dry-run**

Run:

```bash
CI=true pnpm -F @airing-cal/sync-worker test
CI=true pnpm -F @airing-cal/read-worker test
CI=true pnpm test
CI=true pnpm typecheck
CI=true pnpm build:check
pnpm exec openspec validate harden-workflow-request-budget --strict
pnpm exec wrangler deploy --help
CI=true pnpm -F @airing-cal/sync-worker build:check
git diff --check
```

Expected: 全部 PASS；最后一个 build check 完成类型生成校验与 local dry-run，且没有实际 deploy。若测试/类型/构建失败，先加载 `systematic-debugging`，定位根因后新增最小回归测试再修复。

- [ ] **Step 5: 进行 staging/manual shadow 运维验证（需要已有权限，不自动生产变更）**

按 README 中已核实的非破坏性命令启动一个 manual shadow Workflow，记录 instance ID。使用控制面详情核对每个 invocation 的 external/internal 计数低于 Step 1 的证据值、V1 fetch/refresh continuation 出现、完成 run 为 `ok`，并以公开 legacy read smoke 确认返回没有变化。若没有 staging/生产权限，将命令、缺失权限与预期证据写入 verify report，不擅自部署、restart、terminate 或切 read mode。

- [ ] **Step 6: 勾选任务、提交并推送**

确认 Tasks 1.1–3.2 已通过双审后逐项勾选 `openspec/changes/harden-workflow-request-budget/tasks.md`；随后：

```bash
git add README.md docs/superpowers/specs/2026-08-12-harden-workflow-request-budget-design.md openspec/changes/harden-workflow-request-budget/tasks.md apps/sync-worker/src/workflow-core.ts apps/sync-worker/src/workflow.test.ts
git commit -m "docs: document workflow request budget operations"
git push origin dev
```

Expected: commit/push 成功，OpenSpec tasks 仅反映实际完成且双审通过的事项。

## Coverage and Self-Review

- 设计 §2 的 external/internal 分账、成本预留、调用前拒绝：Task 1 的 typed ledger 和 Task 3 所有 stage preflight。
- 设计 §3 的 V1 manifest、冻结时间、版本化 step、可重放续跑：Task 2；legacy prefix 隔离：Task 4。
- 设计 §4 的 collections、calendar、prepare、planner、reservation/commit/finalize、terminalization：Tasks 2–3。
- 设计 §5 的完整性 hash、部分输入不发布、最终 error state：Tasks 2–3 的 RED/GREEN cases。
- 设计 §6 的 health/schema、shadow/legacy/Queue 兼容及非破坏性回滚：Task 4。
- 设计 §7 的多用户 50+ 页、budget、resume、replay、分页失败、尾部失败、终态回归与全仓门禁：Tasks 1–4。

占位符扫描已完成：没有未定项、延后实现提示、泛化错误处理描述或未定义的下游接口引用。类型一致性检查：`InvocationBudget`、`FetchContinuationManifestV1`、`WorkflowStepLike.sleep`、`runBudgetedStage`、`materializeFullFetchFromManifest` 与 V1 step 命名均在后续任务使用前定义。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-12-harden-workflow-request-budget.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
