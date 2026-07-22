## ADDED Requirements

### Requirement: 定时同步必须按日运行
系统 MUST 使用 Worker Cron 在每天 04:00 Asia/Shanghai 创建一个 live Workflow instance，且不得保留每四小时业务同步 schedule。

#### Scenario: 一个完整自然日
- **WHEN** 生产 Cron 正常启用且没有手动触发
- **THEN** 系统只创建一个 scheduled live Workflow instance

### Requirement: 未变化同步不得产生逐 subject 副作用
Workflow MUST 在 enqueue 前筛除未到期且缓存完整的 subject，不得仅因 instance ID 变化而投递全组件媒体任务。

#### Scenario: 659 个 subject 均未变化且未到期
- **WHEN** 每日 Workflow 完成 collections 与 calendar 抓取
- **THEN** Media Queue 收到零个任务且没有逐 subject KV 写入
