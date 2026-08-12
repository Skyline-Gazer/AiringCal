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
