# sync-consistency Specification

## Purpose
TBD - created by archiving change stabilize-sync-consistency. Update Purpose after archive.
## Requirements
### Requirement: Primary 同步必须依赖主账户成功
primary 模式 MUST 在主账户完整拉取成功后才提交 PostgreSQL 权威事务和公开 snapshot；主账户失败时不得覆盖既有数据。

#### Scenario: 主账户失败而其他账户成功
- **WHEN** primary 模式主账户失败且至少一个其他账户成功
- **THEN** 本轮失败并保留原 PostgreSQL 状态和 R2 manifest

### Requirement: 同步快照必须完整提交
收藏与 calendar MUST 在同一 PostgreSQL事务中提交，并作为一个规范 snapshot 发布；事务、生成、上传、回读或 manifest 阶段失败不得向读取端暴露部分新数据。

#### Scenario: 日历获取失败
- **WHEN** 收藏已拉取但 calendar 获取失败
- **THEN** 系统保留上一次权威状态和公开 snapshot 并记录失败

#### Scenario: 发布中途失败
- **WHEN** PostgreSQL 已提交但 R2 manifest 切换失败
- **THEN** 读取端继续使用上一次 manifest，pending publication 可幂等重放

#### Scenario: active manifest 不完整
- **WHEN** manifest 缺少 required 字段、key 非法或 snapshot digest 不匹配
- **THEN** 读取端拒绝本次版本并使用最后验证副本或整套 legacy fallback

#### Scenario: 尚无 active manifest
- **WHEN** 系统处于迁移期且 `public/manifest.json` 不存在
- **THEN** 读取端只允许整套 legacy snapshot 兼容读取

### Requirement: 同步执行不得重叠
系统 MUST 使用宿主机锁和 PostgreSQL advisory lock 防止定时与手动任务同时刷新 token、提交权威状态或切换正式 manifest；shadow run 不得产生正式 publication。

#### Scenario: 已有 live 同步正在执行
- **WHEN** 第二个任务在活动 run 持锁时到达
- **THEN** 第二个任务 skipped 且不调用 bgm.tv 或写正式状态

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
用户 token MUST 仅存在于当前受保护请求或同步进程内存，不得写入 PostgreSQL run/business rows、R2、backup manifest、飞书、日志或容器 image。

#### Scenario: 账号同步结束
- **WHEN** 周期同步、compare 或 apply 完成
- **THEN** 数据库、R2、通知和日志均不包含源或目标 token

### Requirement: 章节收藏同步必须完整分页
系统 MUST 以 bgm.tv 允许的 `limit=1000` 循环 offset 读取章节收藏，直到已读取数量达到响应 `total`。

#### Scenario: 账户有超过一千个章节收藏
- **WHEN** 上游报告 1001 个章节收藏
- **THEN** compare/apply 使用全部 1001 个结果而不是只使用第一页

#### Scenario: 未达到 total 时上游返回空页
- **WHEN** 已累计结果少于 `total` 且下一页 `data` 为空
- **THEN** 系统以明确上游分页错误终止，不得无限循环或返回截断成功结果

### Requirement: 章节写入必须分批并报告部分失败
系统 MUST 将 episode ID 按每批最多 100 个执行 PATCH，并在任一批失败时报告 partial/error 与失败批次，不得宣称静默成功。

#### Scenario: 第二批 PATCH 失败
- **WHEN** 第一批成功而第二批返回错误
- **THEN** 响应明确报告已成功与失败批次并且整体不为完整成功

### Requirement: compare 认证失败不得返回空成功结果
任一账户认证失败时 compare MUST 返回明确非 200 认证错误；双账户失败不得返回空的成功比较。

#### Scenario: 两个 Token 都无效
- **WHEN** compare 的源和目标账户均返回认证失败
- **THEN** endpoint 返回非 200 且包含稳定认证错误码

