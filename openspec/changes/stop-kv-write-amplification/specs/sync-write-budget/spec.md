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
