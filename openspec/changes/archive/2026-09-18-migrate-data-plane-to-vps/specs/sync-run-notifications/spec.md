## ADDED Requirements

### Requirement: 每次同步必须发送飞书终态通知
系统 MUST 对 success、no_change、partial、failed 和 skipped 运行发送飞书 Webhook，内容包含 run ID、generation/hash、数据时间、变化计数、阶段耗时、backup/publication 结果和 git SHA。

#### Scenario: 数据没有变化
- **WHEN** 同步完成且规范内容 hash 未变化
- **THEN** 飞书收到 no_change 通知且 generation 不变

### Requirement: 通知不得影响业务结果
Webhook 失败 MUST 持久化为 notification_failed，但不得回滚 PostgreSQL、snapshot、manifest 或 backup。

#### Scenario: 飞书返回服务错误
- **WHEN** publication 与 backup 成功但 Webhook 重试耗尽
- **THEN** run 保留业务成功结果并记录通知失败供下一轮摘要

### Requirement: 通知和日志必须脱敏
通知、run 错误和日志 MUST 不包含 access token、refresh token、DATABASE_URL、Webhook URL/secret、R2 credential 或未经清理的上游响应体。

#### Scenario: 上游认证失败
- **WHEN** bgm.tv 返回包含请求上下文的认证错误
- **THEN** 飞书和持久化记录只包含稳定错误分类与脱敏摘要
