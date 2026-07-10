## ADDED Requirements

### Requirement: subject 缓存必须支持过期继续服务
系统 MUST 在 subject detail、metadata 或图片进入刷新窗口后继续提供旧缓存，并异步规划刷新任务。

#### Scenario: detail 已进入刷新窗口
- **WHEN** 读取到已有 subject detail 且其确定性刷新时间已到
- **THEN** 快照仍使用旧 detail 并为该 subject 规划刷新

### Requirement: subject 刷新时间必须分散
系统 MUST 根据 subject ID 将常规刷新时间确定性分散在 6 至 8 天，避免同批缓存同时到期。

#### Scenario: 一百个 subject 同时写入
- **WHEN** 一百个不同 subject 在同一时刻完成刷新
- **THEN** 其下一次刷新时间按 subject ID 分散而不是落在同一时刻

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

