## ADDED Requirements

### Requirement: Workflow 请求预算 continuation 必须有回归验证
质量门禁 MUST 验证 Workflow 在 Cloudflare Free Plan 的外部与内部 subrequest 边界下可恢复地处理多用户大分页、准备、刷新规划、重试与终态写入。

#### Scenario: 多用户超过外部请求边界
- **WHEN** 自动测试配置多个用户且合计 collection 页和 calendar 请求超过一次外部请求预算
- **THEN** 每个模拟 invocation 保持在外部和内部预算内，完整输入仅在全部分页成功后生成

#### Scenario: 预算边界发生重试失败
- **WHEN** 测试在内部请求预算尾部注入一次有界 staging 或 run-state 写入失败
- **THEN** Workflow 在保留预算的后续 invocation 写入分类 error，且不遗留 running 状态或部分公开 snapshot

