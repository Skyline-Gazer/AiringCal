## ADDED Requirements

### Requirement: 同步必须由可恢复 Workflow 编排
系统 MUST 使用 Cloudflare Workflow 编排收藏、calendar、快照发布与刷新规划，并为每次 instance 持久化可观测运行状态。

#### Scenario: instance 在中途恢复
- **WHEN** Workflow 在已完成若干分页 step 后恢复
- **THEN** 系统从持久化 step 继续且不重复已完成的外部副作用

### Requirement: Workflow step 必须确定且有界
系统 MUST 使用由阶段、页码、收藏类型或 chunk index 决定的 step 名，并确保每个 step 的外部请求数、CPU 与输出满足 Free Plan 限额。

#### Scenario: 549 条收藏分页
- **WHEN** 收藏接口报告 549 条记录且每页上限为 50
- **THEN** Workflow 只创建 11 个收藏获取 step 且每个 step 输出仅包含 key、数量和摘要

### Requirement: shadow 与 live 发布必须隔离
手动 Workflow MUST 明确选择 `shadow` 或 `live`；shadow 不得覆盖正式 snapshot 或投递 Media Queue，schedule MUST 以 live 模式运行。

#### Scenario: shadow 验证
- **WHEN** 运维创建 shadow instance
- **THEN** 系统只写该 instance 的 shadow snapshot 与审计结果且正式 snapshot 保持不变

### Requirement: 获取失败必须保留上一版正式快照
collections 或 calendar 获取最终失败时，系统 MUST 记录错误状态并保留上一版完整正式 snapshot。

#### Scenario: calendar 重试耗尽
- **WHEN** calendar 请求在允许的重试后仍失败
- **THEN** Workflow 以 error 结束且不发布本次正式收藏或 calendar

### Requirement: Workflow 网络错误必须分类重试
系统 MUST 将 401/403 视为不可重试错误，并对 429、5xx、timeout 与 network error 执行有界指数退避。

#### Scenario: 上游鉴权失败
- **WHEN** 收藏请求返回 401 或 403
- **THEN** 当前 step 不再重试并以脱敏错误结束 instance

#### Scenario: 上游限流
- **WHEN** 收藏请求返回 429
- **THEN** 当前 step 按配置重试且不会覆盖上一版正式 snapshot

### Requirement: Workflow 状态必须可观测
系统 MUST 保存 instance ID、mode、source、status、stage、heartbeat、完成时间、页数、subject 数量、刷新任务数与脱敏错误，并在健康 API 暴露最近运行摘要。

#### Scenario: heartbeat 过期
- **WHEN** 应用记录超过 20 分钟没有 heartbeat 且未完成
- **THEN** 健康 API 将应用状态标记为 stale 并保留 Cloudflare instance ID 供控制面核对

#### Scenario: initialize 后尚未 finalize
- **WHEN** Workflow 已完成 initialize 但尚未写最终 `sync:meta`
- **THEN** 健康 API 通过 `sync:current` 定位该 instance，且 Workflow 与兼容 cron 状态使用同一 effective status

### Requirement: live generation 必须单调提交
系统 MUST 通过 SQLite Durable Object 原子分配 generation 并串行提交 active manifest；较旧 generation 不得覆盖较新的已提交快照。

#### Scenario: 较旧 Workflow 晚完成
- **WHEN** generation 2 先提交而 generation 1 随后请求提交
- **THEN** generation 1 返回 obsolete，`snapshot:active` 仍指向 generation 2

#### Scenario: enqueue 中途失败
- **WHEN** 任一 V3 refresh job 未成功入队
- **THEN** 本次 generation 不得成为 active snapshot
