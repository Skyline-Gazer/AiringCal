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

