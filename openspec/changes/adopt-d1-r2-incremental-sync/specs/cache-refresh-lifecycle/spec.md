## ADDED Requirements

### Requirement: subject media 权威状态必须存入 D1
系统 MUST 将 detail hash、NSFW、图片源 URL、R2 引用、检查时间、下次刷新时间与退避状态保存在 `subject_media`。该 D1-only 新流程 MUST 使用独立的 V4 media job，且不得写逐 subject KV 状态；既有 live V3 job MUST 保持 legacy KV 写入，使当前 Read Worker 与后续 planner 能观察刷新结果。V2/V3 MUST 继续使用既有未加前缀的 number generation Durable Object 围栏以保持在线迁移兼容；V4 MUST 使用独立围栏和由持久化完整同步观察时间、稳定运行 ID 组成的 `{ observed_at, run_id }` generation，MUST NOT 使用执行或 retry 的当前时钟，并 MUST 按 `observed_at`、`run_id` 依次排序。真正无 `version` 的历史消息 MAY 保留 legacy 兼容行为；任何带 `version` 的消息 MUST 严格匹配 canonical V2、V3 或 V4，否则 direct、Queue 与 Durable Object 边界 MUST 在 coordinator、KV、D1、R2 或上游副作用前拒绝或重试。

#### Scenario: 未知显式版本 fail closed
- **WHEN** direct、Queue 或 Durable Object 收到带未知 `version` 的 media job
- **THEN** 系统在任何 coordinator、KV、D1、R2 或上游访问前拒绝或重试该消息，且不得 ack 为成功

#### Scenario: 图片源 URL 未变化
- **WHEN** subject 到期检查返回与 D1 相同的源 URL 和内容 hash
- **THEN** 系统不写图片 R2 对象并只在必要时更新检查调度状态

#### Scenario: 到期成功检查推进调度水位
- **WHEN** 到期 V4 检查成功且 detail、NSFW、源 URL 与 R2 引用均未变化
- **THEN** 系统只更新 `checked_at` 和确定性 6～8 天 `next_refresh_at`，不重写不可变 payload 或图片对象，且次日 hot planner 不再选择该 subject

#### Scenario: 未到期相同内容保持零写
- **WHEN** V4 检查发生在当前 `next_refresh_at` 之前且语义内容相同
- **THEN** D1 与 R2 写入均为零，现有调度水位保持不变

#### Scenario: V3 与 V4 围栏独立且 V4 replay 稳定
- **WHEN** 同一 subject 依次处理 V3 generation N、V4 run A、重放 A、较新的 V4 run B、迟到 A，再处理 V3 generation N+1
- **THEN** A 只执行一次且重放为 duplicate，B 执行且迟到 A 为 obsolete，N+1 仍执行，并且两套围栏状态互不覆盖

#### Scenario: V4 retry 不使用当前时钟
- **WHEN** 同一稳定运行与完整输入在不同执行时间重试 media planning
- **THEN** 生成的 `{ observed_at, run_id }` 完全相同，且较新的 authoritative observation 按 tuple 顺序推进 V4 围栏

### Requirement: 媒体外部提交必须由 durable pending checkpoint 保护
系统 MUST 在预算/Queue 外部提交前持久化并采用 versioned `media_pending` artifact，冻结规范请求、候选优先级与 cold cursor 计划。running replay MUST 使用冻结请求及稳定 reservation ID，不得根据后续变化的 `subject_media` 重新规划。

#### Scenario: Queue 接受后进程丢失
- **WHEN** Queue 已接受媒体提交，但进程在 prepared result 持久化前丢失，且重放前 `subject_media` 发生变化
- **THEN** 重放提交 byte-identical 请求并由预算幂等状态返回已存结果，不执行第二次 Queue send，且候选计数、deferred 计数和 cold cursor 目标保持不变

#### Scenario: pending checkpoint 未采用
- **WHEN** `media_pending` manifest 持久化或 `sync_runs` adoption 失败
- **THEN** 系统不得调用预算/Queue 提交，运行保留最后一个已采用 checkpoint 并进入分类失败路径

### Requirement: cold media 必须七日轮转
`watched` subject MUST 作为 cold 按 subject ID 确定性分成七个 shard，其他收藏状态 MUST 作为 hot 按到期时间调度。

#### Scenario: 七个连续日同步
- **WHEN** 预算充足且连续运行七天
- **THEN** 每个 cold subject 恰好至少被选择复查一次
