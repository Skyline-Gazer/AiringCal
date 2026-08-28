## ADDED Requirements

### Requirement: VPS 同步必须作为一次性任务运行
系统 MUST 允许宿主机定时器通过 Docker Compose 启动一次同步任务，并以进程退出码表达成功、部分成功或失败，且不得暴露公网监听端口。

#### Scenario: 宿主机触发每日同步
- **WHEN** cron 执行一次 Compose sync service
- **THEN** 容器完成单轮同步后退出且不会保留常驻 HTTP 服务

### Requirement: 同步必须使用双层互斥
宿主机任务 MUST 使用进程锁，运行时 MUST 使用 PostgreSQL advisory lock；未获得任一锁的任务不得抓取或发布数据。

#### Scenario: 手动任务与定时任务重叠
- **WHEN** 第二个任务在首个任务持有数据库锁时启动
- **THEN** 第二个任务记录 skipped 结果并且不调用 bgm.tv 或 R2 写接口

### Requirement: 完整输入失败不得发布
系统 MUST 完整获取所有配置账户的收藏和 calendar 后才提交权威状态；认证、分页、校验或最终重试失败 MUST 保留上一版公开 manifest。

#### Scenario: 收藏分页中途失败
- **WHEN** 已读取部分页面后上游重试耗尽
- **THEN** 本轮记录失败且不确认删除、不提交公开 snapshot

### Requirement: 同步运行必须持久化终态
每轮任务 MUST 持久化 run ID、阶段、开始/结束时间、计数、耗时、git SHA 和脱敏错误，并区分 success、no_change、partial、failed 与 skipped。

#### Scenario: 备份失败但发布成功
- **WHEN** snapshot 已发布而数据库备份上传失败
- **THEN** run 终态为 partial 且保留发布与备份各自结果
