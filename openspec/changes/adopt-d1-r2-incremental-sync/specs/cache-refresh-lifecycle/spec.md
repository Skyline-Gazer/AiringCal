## ADDED Requirements

### Requirement: subject media 权威状态必须存入 D1
系统 MUST 将 detail hash、NSFW、图片源 URL、R2 引用、检查时间、下次刷新时间与退避状态保存在 `subject_media`。该 D1-only 新流程 MUST 使用独立的 V4 media job，且不得写逐 subject KV 状态；既有 live V3 job MUST 保持 legacy KV 写入，使当前 Read Worker 与后续 planner 能观察刷新结果。真正无 `version` 的历史消息 MAY 保留 legacy 兼容行为；任何带 `version` 的消息 MUST 严格匹配 canonical V2、V3 或 V4，否则 direct、Queue 与 Durable Object 边界 MUST 在 coordinator、KV、D1、R2 或上游副作用前拒绝或重试。

#### Scenario: 未知显式版本 fail closed
- **WHEN** direct、Queue 或 Durable Object 收到带未知 `version` 的 media job
- **THEN** 系统在任何 coordinator、KV、D1、R2 或上游访问前拒绝或重试该消息，且不得 ack 为成功

#### Scenario: 图片源 URL 未变化
- **WHEN** subject 到期检查返回与 D1 相同的源 URL 和内容 hash
- **THEN** 系统不写图片 R2 对象并只在必要时更新检查调度状态

### Requirement: cold media 必须七日轮转
`watched` subject MUST 作为 cold 按 subject ID 确定性分成七个 shard，其他收藏状态 MUST 作为 hot 按到期时间调度。

#### Scenario: 七个连续日同步
- **WHEN** 预算充足且连续运行七天
- **THEN** 每个 cold subject 恰好至少被选择复查一次
