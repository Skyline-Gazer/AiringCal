# sync-consistency Specification

## Purpose
TBD - created by archiving change stabilize-sync-consistency. Update Purpose after archive.
## Requirements
### Requirement: Primary 同步必须依赖主账户成功
primary 模式 MUST 在主账户拉取成功后才生成新快照，主账户失败时不得覆盖已有收藏。

#### Scenario: 主账户失败而其他账户成功
- **WHEN** primary 模式的主账户拉取失败且至少一个其他账户成功
- **THEN** 本次同步失败并保留原有收藏和日历快照

### Requirement: 同步快照必须完整提交
收藏与日历 MUST 作为同一次 Workflow instance 的结果提交；生成或发布阶段失败时不得向读取端暴露部分新数据。

#### Scenario: 日历获取失败
- **WHEN** 收藏已拉取但日历获取失败
- **THEN** 系统保留上一次完整快照并记录失败状态

#### Scenario: 发布中途失败
- **WHEN** 部分 staging 数据已写入但最终提交点失败
- **THEN** 读取端继续使用上一次已提交 snapshot

#### Scenario: active manifest 不完整
- **WHEN** `snapshot:active` 存在但任一 required versioned key 缺失或 digest 不匹配
- **THEN** 读取端返回 503 `SNAPSHOT_INCOMPLETE` 且不得逐 key 回退到 legacy 数据

#### Scenario: 尚无 active manifest
- **WHEN** 系统处于迁移期且 `snapshot:active` 不存在，或 pointer 恰好是合法的 instance/mode/published_at/subject_count 旧四字段结构
- **THEN** 读取端只允许整套 legacy snapshot 兼容读取

### Requirement: 同步执行不得重叠
系统 MUST 防止旧业务 Cron、Worker Cron 创建的 Workflow 与手动 live instance 同时刷新同一 token 或提交同一正式快照；shadow instance 不得产生正式副作用。

#### Scenario: 已有 live 同步正在执行
- **WHEN** 第二个 live 同步在活动 instance 仍运行时到达
- **THEN** 系统拒绝或跳过第二次执行且不刷新 token或写正式 snapshot

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
系统 MUST 验证模式、方向、用户名、token、条目 ID 与 apply items；无效输入或超过批量上限的输入不得触发 bgm.tv 写操作。

#### Scenario: 模式无效
- **WHEN** 请求提供非 full 或 partial 的模式
- **THEN** 系统返回 400 且不调用 bgm.tv

#### Scenario: apply 超过五条
- **WHEN** 请求包含超过 5 个 items 或 subject IDs
- **THEN** 系统返回 400 且不读取全部源收藏或调用 bgm.tv 写接口

### Requirement: compare 结果必须可直接用于 apply
`/api/sync/apply` MUST 接收最多 5 个经过校验的 compare items 并直接执行对应写操作，不得为每个批次重新拉取全部源收藏。

#### Scenario: 使用 compare items 应用一批变更
- **WHEN** 客户端提交 5 个有效 compare items
- **THEN** apply 使用这些 items 且不调用源账户 collections GET

### Requirement: 用户凭证不得进入异步或持久化业务载荷
用户 token MUST 仅在当前受保护请求内使用，不得写入 Workflow params、KV、Queue 或 operation log。

#### Scenario: 账号同步结束
- **WHEN** compare 或 apply 请求完成
- **THEN** operation log 和所有异步消息不包含源或目标 token

