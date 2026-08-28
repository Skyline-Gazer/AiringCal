## ADDED Requirements

### Requirement: 发布后必须生成可恢复数据库备份
系统 MUST 在成功发布或确认 no-change 后生成 PostgreSQL custom-format dump、校验摘要和备份 manifest，并上传到私有 R2 backup prefix。

#### Scenario: 完整同步成功
- **WHEN** 权威事务和 publication 阶段完成
- **THEN** 系统上传可由标准 PostgreSQL 工具恢复的 dump 与对应 manifest

### Requirement: 备份失败不得撤销发布
备份属于 publication 后阶段；失败 MUST 令 run 成为 partial，但不得回滚数据库或已切换的公开 manifest。

#### Scenario: R2 backup 上传超时
- **WHEN** snapshot 已发布而 dump 上传重试耗尽
- **THEN** 公开版本继续服务且通知明确报告 backup failed

### Requirement: 备份保留与恢复必须可验证
系统 MUST 保留最近 30 个每日备份和每月最后一个归档，只删除显式枚举且确认过期的 key，并提供恢复到空数据库的校验流程。

#### Scenario: 执行恢复演练
- **WHEN** 运维下载一个保留中的 dump 并恢复到空库
- **THEN** schema、核心行数和重新生成的 snapshot hash 均通过校验
