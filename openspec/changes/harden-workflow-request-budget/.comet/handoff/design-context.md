# Comet Design Handoff

- Change: harden-workflow-request-budget
- Phase: design
- Mode: compact
- Context hash: 0821e1c0a5dbf8c1d772ead87ab9e6e22089b4116bd34f35ed68083f48d8d4e2

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/harden-workflow-request-budget/proposal.md

- Source: openspec/changes/harden-workflow-request-budget/proposal.md
- Lines: 1-26
- SHA256: 2eeea1b8486d48e8141c3d7ce428fd020db1482864878d7b71a6314eaf66f565

```md
## Why

当前每日同步在单个 Worker invocation 中顺序抓取全部 collections、calendar 并准备输入。多用户或大量分页会超过 Cloudflare Workers Free Plan 的外部或内部 subrequest 限额，使 Workflow 在发布前失败，且可能无法记录终态错误。

## What Changes

- 将 collections、calendar 与准备阶段拆分为可续跑的 Workflow continuation，任何单次 invocation 都不超过对应的外部和内部 subrequest 预算。
- 引入可持久化的请求账本与 fetch continuation manifest；它们记录已完成页、calendar 状态和预算消耗，但不保存 token 或上游原始错误内容。
- 保持“所有 collections 页与 calendar 均成功后才进行删除判断、D1 提交和 snapshot 发布”的完整输入门禁。
- 让重试和终态错误记录在独立且有预留预算的 invocation 中执行，避免请求耗尽后遗留 running 状态。
- 保持现有公开 API、legacy 读取路径、媒体预算、Queue 语义和 shadow 无副作用边界不变。

## Capabilities

### New Capabilities

- `workflow-subrequest-budgeting`: 定义 Workflow 在 Free Plan 外部与内部 subrequest 限额下的持久化预算、continuation、重试和终态记录契约。

### Modified Capabilities

- `durable-sync-workflow`: Workflow 完整输入抓取从单 invocation 顺序执行改为可续跑的分页 continuation，仍以完整成功输入作为提交门槛。
- `project-quality-gates`: 增加多用户大分页、外部/内部 subrequest 边界、continuation replay 与预算尾部终态写入的验证要求。

## Impact

影响 `apps/sync-worker` 的 Workflow 编排、step/staging 类型和测试，以及 README、同步技术设计与质量门禁规格。不会新增公开端点、Cloudflare 资源、环境变量、付费服务或 token 持久化。
```

## openspec/changes/harden-workflow-request-budget/design.md

- Source: openspec/changes/harden-workflow-request-budget/design.md
- Lines: 1-46
- SHA256: ab6bdcfadc8e72f8108cfcfd01d9e958185245ecbfc529c367256368343e5bb3

```md
## Context

`SyncWorkflow` 目前在一次 Worker invocation 中抓取所有用户的 collections、calendar 并准备完整输入。请求数随用户数和分页数线性增加：上游 fetch 受 Free Plan 外部 subrequest 限制，KV、D1、Durable Object、Queue 等受内部 service subrequest 限制。仅在 refresh planning 阶段 sleep 无法保护之前的 fetch/prepare 工作。

## Goals / Non-Goals

**Goals:**

- 保留任意数量的 `BANGUMI_USERS` 与完整分页读取语义。
- 在每次 invocation 前以可验证预算切分外部抓取和内部处理。
- 使用 durable continuation 使休眠、重试和 replay 不重复外部副作用。
- 为最终错误状态保留独立预算与可观测性。

**Non-Goals:**

- 不新增公开 API、Cloudflare 资源、环境变量、付费服务或 token 持久化。
- 不改变 legacy 公开读取、media 预算、Queue job 契约、D1/R2 发布顺序或 shadow 隔离。
- 不以限制用户数量或静默跳过分页作为规避上限的手段。

## Decisions

1. 使用单一 typed `InvocationBudget`，分别追踪 external fetch 与 internal service 调用；每个阶段的最大工作量由账本和终态余量计算，而不是依赖固定 subject/page fixture。
   - 替代方案：固定每 N 页 sleep。拒绝，因为多用户与重试会使真实请求成本不同。
2. collections fetch 使用由 user/page 组成的确定性 step，完成一组后通过 durable continuation 续跑；calendar 也在有外部预算的独立阶段执行。staging manifest 只保存页摘要、游标、完整性和固定 run 时间。
   - 替代方案：单次 fetch 全部页后仅切分 planning。拒绝，因为外部预算会先耗尽。
3. prepare、planning、reservation/commit/finalize 各在独立且有内部预算余量的 invocation group 中执行。终态错误写入使用预留的独立边界，不能与可能耗尽预算的工作竞争。
   - 替代方案：靠同一 invocation 的 catch 写 error。拒绝，因为生产事故已证明请求耗尽会让 `record-error` 同时失败。
4. 所有 continuation 从 Workflow step history 和 staging manifest 重建；planner 使用 persisted `sync:run.started_at`，避免 sleep 改变到期判断。

## Risks / Trade-offs

- [更多 Workflow steps 与休眠延迟] → 按预算批处理而非逐页/逐 chunk sleep，并以稳定 step 名复用 history。
- [staging manifest 损坏或缺页] → 视为完整输入失败；不执行删除、D1 提交或发布。
- [预算模型漏计新 service call] → 所有外部/内部调用通过集中 ledger 包装，新增调用须有预算测试。
- [旧 instance 与新 step 拓扑不兼容] → 使用新 step 前缀/版本化 manifest；部署只影响新 instance，旧 instance 按原历史完成或终态化。

## Migration Plan

1. 以新 step 名和 manifest schema 实现 continuation，保留旧 step 读取兼容直到已运行 instance 过期。
2. 全仓门禁与 materialized Wrangler dry-run 通过后合并、部署 immutable `dev` SHA。
3. 用新的 manual shadow 和 live Workflow 验证外部/内部计数、完整输入、终态错误和公开 legacy API；再恢复每日成功观测。
4. 回滚仅部署上一兼容 SHA；不删除 staging、D1/R2/KV/Queue 或 Durable Object 数据。

## Open Questions

无。预算常量和每阶段保留余量将在实现前通过官方限制与本地类型再次验证，并由测试锁定。
```

## openspec/changes/harden-workflow-request-budget/tasks.md

- Source: openspec/changes/harden-workflow-request-budget/tasks.md
- Lines: 1-15
- SHA256: 2034c567321baba802f12be5fdd2b2fd8fad234f664c3acc675902dfe5d4514e

```md
## 1. 预算模型与 durable continuation

- [ ] 1.1 通过官方限制、Worker 类型与现有调用点定义 typed external/internal invocation budget，并为所有计算增加终态与重试余量测试
- [ ] 1.2 引入版本化 fetch continuation manifest 与确定性新 step 名，使任意用户/页数的 collections 获取按外部预算跨 invocation 续跑
- [ ] 1.3 将 calendar 和完整输入 prepare 放入有内部预算余量的 continuation 阶段；缺页、损坏 manifest 或最终重试失败时 fail closed

## 2. 安全终态与兼容运行

- [ ] 2.1 将 live refresh planning、reservation、commit、finalize 与 record-error 接入统一内部预算边界，并保留固定 planner 时间和 replay 幂等性
- [ ] 2.2 保持旧运行实例的历史 step 兼容，确保 shadow 隔离、legacy 公共读取、媒体预算与 Queue 契约不发生变化

## 3. 验证与运维文档

- [ ] 3.1 添加多用户 50+ 页、外部/内部预算边界、休眠恢复、分页失败、预算尾部重试和终态记录的 RED→GREEN 回归测试
- [ ] 3.2 更新 README、同步设计和运维证据，运行全仓门禁、materialized Wrangler dry-runs 与 OpenSpec 严格验证
```

## openspec/changes/harden-workflow-request-budget/specs/durable-sync-workflow/spec.md

- Source: openspec/changes/harden-workflow-request-budget/specs/durable-sync-workflow/spec.md
- Lines: 1-24
- SHA256: e032109ed1bc51f3ba3b7a8e693526f8ca97c2c4c18487c0b290099face87774

```md
## MODIFIED Requirements

### Requirement: Workflow step 必须确定且有界
系统 MUST 使用由阶段、页码、收藏类型或 chunk index 决定的 step 名，并确保每个 step 与每次 Workflow invocation 的外部请求数、Cloudflare 内部 service subrequest 数、CPU 与输出满足 Free Plan 限额。跨 invocation 的 collections、calendar、准备和 refresh 阶段 MUST 从持久化 step history 与 staging manifest 续跑，且不得改变完整输入、快照提交或刷新规划的业务语义。

#### Scenario: 549 条收藏分页
- **WHEN** 收藏接口报告 549 条记录且每页上限为 50
- **THEN** Workflow 只创建 11 个收藏获取 step 且每个 step 输出仅包含 key、数量和摘要

#### Scenario: 多用户大分页 continuation
- **WHEN** 已配置的多个用户合计需要超过一次 invocation 预算的 collections 页
- **THEN** Workflow 在确定性 continuation 边界后继续获取剩余页，并且只有全部页与 calendar 成功后才准备完整输入

### Requirement: 获取失败必须保留上一版正式快照
collections 或 calendar 获取最终失败时，系统 MUST 记录错误状态并保留上一版完整正式 snapshot。任何 continuation 尚未完成时，系统 MUST NOT 对 D1 执行删除判定、提交本次 snapshot 或把部分 collections/calendar 暴露给读取端。

#### Scenario: calendar 重试耗尽
- **WHEN** calendar 请求在允许的重试后仍失败
- **THEN** Workflow 以 error 结束且不发布本次正式收藏或 calendar

#### Scenario: 分页 continuation 后的某页失败
- **WHEN** Workflow 已持久化部分 collections 页但后续页在允许的重试后失败
- **THEN** 已完成页仅保留为该 instance 的 staging 数据，上一版正式 snapshot 保持不变且本次不推进删除状态

```

## openspec/changes/harden-workflow-request-budget/specs/project-quality-gates/spec.md

- Source: openspec/changes/harden-workflow-request-budget/specs/project-quality-gates/spec.md
- Lines: 1-13
- SHA256: 5ea77694251cd8cf4c16508b9ef4109065d9ed779eb7dc8019cb3481fab930a1

```md
## ADDED Requirements

### Requirement: Workflow 请求预算 continuation 必须有回归验证
质量门禁 MUST 验证 Workflow 在 Cloudflare Free Plan 的外部与内部 subrequest 边界下可恢复地处理多用户大分页、准备、刷新规划、重试与终态写入。

#### Scenario: 多用户超过外部请求边界
- **WHEN** 自动测试配置多个用户且合计 collection 页和 calendar 请求超过一次外部请求预算
- **THEN** 每个模拟 invocation 保持在外部和内部预算内，完整输入仅在全部分页成功后生成

#### Scenario: 预算边界发生重试失败
- **WHEN** 测试在内部请求预算尾部注入一次有界 staging 或 run-state 写入失败
- **THEN** Workflow 在保留预算的后续 invocation 写入分类 error，且不遗留 running 状态或部分公开 snapshot

```

## openspec/changes/harden-workflow-request-budget/specs/workflow-subrequest-budgeting/spec.md

- Source: openspec/changes/harden-workflow-request-budget/specs/workflow-subrequest-budgeting/spec.md
- Lines: 1-31
- SHA256: 25596d402f73bcfdfeaf60cbd46809b748b5174e7ee30bcbd0cdc9ce61e73381

```md
## ADDED Requirements

### Requirement: Workflow MUST budget external and internal subrequests independently
The Workflow MUST use a typed, persisted accounting model for each invocation. It MUST reserve capacity independently for upstream internet fetches and Cloudflare internal service subrequests, including continuation, retry and terminal-error work. The accounting model MUST NOT persist tokens, upstream response bodies or raw error payloads.

#### Scenario: Multi-user collections exceed one external-request budget
- **WHEN** multiple configured users require more than one Free Plan external-fetch budget of collection pages plus calendar work
- **THEN** the Workflow persists completed page outputs and continues in a later invocation before either invocation exceeds its external-request budget

#### Scenario: Internal request budget reaches a continuation boundary
- **WHEN** staging, preparation or refresh planning would consume the invocation's internal-service budget
- **THEN** the Workflow durably records its continuation position and resumes before the budget is exceeded

### Requirement: Workflow continuation MUST be durable and replay-safe
The Workflow MUST reconstruct fetch, preparation and planning progress solely from deterministic step history and persisted staging manifests after a durable continuation. It MUST NOT depend on in-memory arrays, clocks after run initialization, or a mutable latest-pointer key to resume.

#### Scenario: Workflow resumes after a collection-fetch continuation
- **WHEN** a Workflow resumes after one or more durable collection-fetch continuations
- **THEN** it does not refetch or duplicate staging writes for completed pages and fetches each remaining page exactly once for that instance

#### Scenario: Workflow resumes after a planning continuation
- **WHEN** a live Workflow resumes after a planning continuation
- **THEN** candidate order, frozen due-time evaluation, reservation request and media job IDs remain byte-equivalent to an uninterrupted run

### Requirement: Budget exhaustion MUST leave an observable terminal result
Before an invocation can exhaust its request budget, the Workflow MUST reserve a distinct continuation or terminalization boundary. A final retry failure MUST record a classified terminal error without publishing a partial snapshot or leaving the application run state falsely running.

#### Scenario: A bounded staging write retry exhausts
- **WHEN** a staging or run-state write reaches its configured retry limit near a request-budget boundary
- **THEN** a later reserved invocation records the terminal error, preserves the previous formal snapshot and exposes a non-running run status

```

