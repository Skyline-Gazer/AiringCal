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
