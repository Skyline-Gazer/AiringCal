# cache-refresh-lifecycle Specification

## Purpose
TBD - created by archiving change adopt-free-plan-sync-workflow. Update Purpose after archive.
## Requirements
### Requirement: subject 缓存必须支持过期继续服务
系统 MUST 在 subject detail、metadata 或图片进入刷新窗口后继续提供旧缓存，并异步规划刷新任务。

#### Scenario: detail 已进入刷新窗口
- **WHEN** 读取到已有 subject detail 且其确定性刷新时间已到
- **THEN** 快照仍使用旧 detail 并为该 subject 规划刷新

### Requirement: subject 刷新时间必须分散
系统 MUST 根据 subject ID 将常规刷新时间确定性分散在 6 至 8 天，并且只有到达该时间、缓存缺失或源内容发生变化时才规划对应组件刷新。

#### Scenario: 一百个 subject 同时写入
- **WHEN** 一百个不同 subject 在同一时刻完成刷新
- **THEN** 其下一次刷新时间按 subject ID 分散而不是落在同一时刻

#### Scenario: subject 尚未到期
- **WHEN** detail、metadata 与两种图片均完整且确定性刷新时间仍在未来
- **THEN** 系统不创建该 subject 的媒体任务

### Requirement: Media Queue 消息必须可去重
每个刷新消息 MUST 包含由 Workflow instance 与 subject ID 组成的 `job_id`，consumer MUST 跳过已经完成或正在处理的重复 job。

#### Scenario: enqueue step 重放
- **WHEN** 同一 enqueue step 因恢复再次投递相同 job
- **THEN** Media consumer 不重复下载、写 R2 或覆盖已完成状态

### Requirement: 刷新状态与图片结果必须分离
系统 MUST 用 `subject:refresh:{subjectId}` 表达 queued/running/ok/partial/failed，用 `image:status:{subjectId}` 只表达真实图片缓存结果。

#### Scenario: metadata 成功但图片缺少源 URL
- **WHEN** Media consumer 成功更新 metadata 但无法取得图片源 URL
- **THEN** refresh 状态为 partial 或相应终态且 image status 不得伪装为任务成功

### Requirement: Media Queue 重试必须区分瞬态与终态
consumer MUST 对 timeout、network、429 与 5xx 使用有界延迟重试，对 404 与缺失源图写终态后 ack。

#### Scenario: 图片上游暂时返回 503
- **WHEN** 图片下载返回 503 且未超过最大重试次数
- **THEN** 消息按 30、120、300 秒策略中的相应延迟重试

#### Scenario: subject 不存在
- **WHEN** subject detail 返回 404
- **THEN** consumer 写入不存在终态并 ack 消息

### Requirement: subject 副作用必须按 generation 串行
系统 MUST 使用每 subject 一个 SQLite Durable Object 串行执行 detail、metadata、图片、R2 与 refresh 状态副作用，并拒绝低于已处理 generation 的消息。

#### Scenario: 旧 job 晚到达
- **WHEN** 同一 subject 的新 generation 已完成后旧 generation 消息才到达
- **THEN** 旧消息以 obsolete ack，且不得覆盖 KV、R2 或刷新状态

#### Scenario: legacy job 与 V3 共存
- **WHEN** generation 0 的 V2/legacy job 在更高 V3 generation 已处理后到达
- **THEN** legacy job 以 obsolete ack 且不执行刷新副作用

### Requirement: subject 404 必须建立保守 tombstone
subject detail 返回 404 时，系统 MUST 停止返回旧 detail，并写入 TTL 为 24 小时的 `exists: false`、`nsfw: true`、`reason: not_found` tombstone。

#### Scenario: 已缓存 subject 后变成 404
- **WHEN** 刷新已缓存 subject 得到 404
- **THEN** 旧 detail 不再返回且读取端采用保守 NSFW 元数据

#### Scenario: tombstone TTL 内再次刷新
- **WHEN** 同一 subject 在 tombstone TTL 到期前再次进入刷新路径
- **THEN** 系统不重复请求 subject detail 上游

#### Scenario: 上游网络或服务错误
- **WHEN** subject detail 请求因网络、429 或 5xx 失败
- **THEN** 系统不得写 not_found tombstone，并继续使用既有 stale-on-error 语义

### Requirement: 相同媒体状态不得重复写入
Media consumer MUST 在写 refresh、metadata 或 image status 前比较规范内容；缓存复用且状态未变化时不得执行对应 KV PUT。

#### Scenario: 两种图片均可复用
- **WHEN** job 的源 URL 与已缓存 source URL 相同且 detail 未到期
- **THEN** consumer 不下载图片且不重写 image status 或 metadata

