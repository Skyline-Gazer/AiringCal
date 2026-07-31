## MODIFIED Requirements

### Requirement: subject 刷新时间必须分散
系统 MUST 根据 subject ID 将常规刷新时间确定性分散在 6 至 8 天，并且只有到达该时间、缓存缺失或源内容发生变化时才规划对应组件刷新。

#### Scenario: 一百个 subject 同时写入
- **WHEN** 一百个不同 subject 在同一时刻完成刷新
- **THEN** 其下一次刷新时间按 subject ID 分散而不是落在同一时刻

#### Scenario: subject 尚未到期
- **WHEN** detail、metadata 与两种图片均完整且确定性刷新时间仍在未来
- **THEN** 系统不创建该 subject 的媒体任务

## ADDED Requirements

### Requirement: 相同媒体状态不得重复写入
Media consumer MUST 在写 refresh、metadata 或 image status 前比较规范内容；缓存复用且状态未变化时不得执行对应 KV PUT。

#### Scenario: 两种图片均可复用
- **WHEN** job 的源 URL 与已缓存 source URL 相同且 detail 未到期
- **THEN** consumer 不下载图片且不重写 image status 或 metadata
