## ADDED Requirements

### Requirement: 媒体调度必须受每日预算约束
系统 MUST 在任务进入 Media Queue 前应用每日 soft limit 50 与 hard limit 100，并按新增或变化、hot 到期、cold 轮转、失败重试的顺序选择任务。

#### Scenario: 候选任务超过 soft limit
- **WHEN** 当日存在 80 个普通到期候选且没有更高优先级任务
- **THEN** 系统最多投递 50 个任务并将其余候选留待下一日重新规划

#### Scenario: 新增任务超过 soft limit
- **WHEN** 当日有 60 个新增 subject 需要必要媒体补全
- **THEN** 系统可以超过 soft limit 但不得超过 hard limit 100

### Requirement: 媒体预算耗尽不得阻塞收藏发布
系统 MUST 独立完成收藏与 calendar snapshot 发布，媒体候选被截断时不得使 Workflow 失败。

#### Scenario: 当日媒体 hard limit 已用尽
- **WHEN** Workflow 完成收藏抓取且没有剩余媒体预算
- **THEN** 系统发布收藏 snapshot、记录零投递并正常完成

### Requirement: 所有 live 运行必须共享每日媒体预算
系统 MUST 以 UTC 日期作为预算周期，使 scheduled live 与 manual live Workflow 共享同一 soft limit 与 hard limit；系统不得提供绕过 hard limit 的强制投递参数。Shadow Workflow MUST 不投递媒体任务。

#### Scenario: 手动运行发生在定时运行之后
- **WHEN** scheduled live 已用尽当日 hard limit，随后触发 manual live
- **THEN** manual live 投递零个媒体任务、仍发布收藏 snapshot 并正常完成

#### Scenario: 运行 shadow Workflow
- **WHEN** 任意 UTC 日期触发 shadow Workflow
- **THEN** Workflow 不预留媒体预算且不向 Media Queue 投递任务

### Requirement: Queue 确认歧义必须 fail-closed
系统 MUST 以 coordinator 的实际 UTC 日期和稳定 reservation ID 预留逻辑媒体预算。每个 reservation MUST 最多发起一次 Queue producer 调用；Queue 抛错或确认状态写入中断时 MUST 保留当日预算、标记为不确定且不得重发，同时 MUST 继续发布收藏 snapshot。物理 Queue 的 at-least-once 重复交付 MUST 由确定性 job ID 和 subject coordinator 消除已完成任务的重复业务副作用。

#### Scenario: Queue 已受理但响应丢失
- **WHEN** producer 调用发生歧义异常且同一 Workflow step 随后重放
- **THEN** coordinator 返回原逻辑 grant、不再次扣减预算、不再次调用 producer，并允许 Workflow 完成 snapshot 发布

#### Scenario: 跨午夜的旧 Workflow 晚到
- **WHEN** payload 携带旧日期但 coordinator 在新的 UTC 日期处理 reservation
- **THEN** 容量只计入 coordinator 的实际 UTC 日期，旧 payload 不得重开另一份 hard limit
