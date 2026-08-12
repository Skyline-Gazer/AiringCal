# Brainstorm Summary

- Change: harden-workflow-request-budget
- Date: 2026-08-12

## 确认的技术方案

用户确认采用版本化 continuation manifest 与 Workflow durable step history。同步按阶段推进：collections 分页抓取、calendar、完整输入 prepare、live refresh planning 和发布。每个 invocation 用独立 typed ledger 约束 external fetch 与 Cloudflare internal service subrequests；接近预算边界时在确定性位置持久化进度并通过 durable continuation 恢复。恢复不依赖内存、可变 latest pointer 或运行开始后的时钟。

## 关键取舍与风险

- 不采用固定“每 N 页” sleep：它无法适应多用户、分页数和重试成本。
- 不限制用户或静默跳页：必须保持完整输入门禁和现有多用户语义。
- manifest 损坏、缺页或最终重试失败必须 fail closed：保留上一版正式 snapshot，不进行删除、D1 提交或发布。
- 终态错误必须位于预留的独立 continuation 边界，避免预算耗尽后遗留 running 状态。
- 使用新的版本化 step 前缀和 manifest schema；旧实例继续按其既有 history 完成或终态化。

## 测试策略

- 以模拟 invocation ledger 验证 external 与 internal 预算分别不超限。
- 覆盖多用户 50+ 页、分页 continuation/replay、不重复 fetch 或 staging write。
- 覆盖 calendar/prepare 完整输入门禁、planning replay 的候选与媒体 job ID 稳定性。
- 覆盖预算尾部 staging/run-state 重试失败后，在独立 invocation 写入分类终态 error，且不发布部分 snapshot。

## Spec Patch

无。现有 delta spec 已覆盖预算分离、可续跑、完整输入门禁与终态可观测性。
