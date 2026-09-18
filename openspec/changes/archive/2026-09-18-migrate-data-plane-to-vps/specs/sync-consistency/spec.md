## MODIFIED Requirements

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

### Requirement: 用户凭证不得进入异步或持久化业务载荷
用户 token MUST 仅存在于当前受保护请求或同步进程内存，不得写入 PostgreSQL run/business rows、R2、backup manifest、飞书、日志或容器 image。

#### Scenario: 账号同步结束
- **WHEN** 周期同步、compare 或 apply 完成
- **THEN** 数据库、R2、通知和日志均不包含源或目标 token
