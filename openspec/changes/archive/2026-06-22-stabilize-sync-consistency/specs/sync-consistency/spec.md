## ADDED Requirements

### Requirement: Primary 同步必须依赖主账户成功
primary 模式 MUST 在主账户拉取成功后才生成新快照，主账户失败时不得覆盖已有收藏。

#### Scenario: 主账户失败而其他账户成功
- **WHEN** primary 模式的主账户拉取失败且至少一个其他账户成功
- **THEN** 本次同步失败并保留原有收藏和日历快照

### Requirement: 同步快照必须完整提交
收藏与日历 MUST 作为同一次同步结果提交；生成阶段失败时不得留下部分新数据。

#### Scenario: 日历获取失败
- **WHEN** 收藏已拉取但日历获取失败
- **THEN** 系统保留上一次完整快照并记录失败状态

### Requirement: 同步执行不得重叠
系统 MUST 防止 Cron 与手动触发的同步流程同时刷新同一 token 或写入同一快照。

#### Scenario: 已有同步正在执行
- **WHEN** 第二个同步请求在锁有效期内到达
- **THEN** 系统拒绝或跳过第二次执行且不刷新 token

### Requirement: Token 探测必须区分失效与网络故障
系统 MUST 仅在确认 token 无效或临近到期时刷新；网络或上游临时故障不得被当作 token 无效。

#### Scenario: token_status 网络超时
- **WHEN** token 状态探测因网络问题失败
- **THEN** 同步报告可重试错误且不消费 refresh token

### Requirement: 管理同步语义必须明确
管理端 MUST 将当前行为定义为“将源账户条目复制或更新到目标账户”，不得声称目标账户会被完整镜像。

#### Scenario: 目标账户存在源账户没有的条目
- **WHEN** 用户执行完整复制
- **THEN** 目标账户独有条目保持不变且界面明确提示该行为

### Requirement: 同步输入必须验证
系统 MUST 验证模式、方向、用户名、token 和条目 ID；无效输入不得触发 bgm.tv 写操作。

#### Scenario: 模式无效
- **WHEN** 请求提供非 full 或 partial 的模式
- **THEN** 系统返回 400 且不调用 bgm.tv
