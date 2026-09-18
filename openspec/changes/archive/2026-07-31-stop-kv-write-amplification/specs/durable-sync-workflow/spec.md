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

### Requirement: 同步运行指标必须可闭合且不得冒充实际 KV 写入
系统 MUST 分别记录 eligible candidates（含优先级分布）、planner selected、logical granted、budget deferred、confirmed/uncertain producer outcome 与 skipped subjects。`refresh_jobs` 若为兼容保留 MUST 明确定义为 logical granted；Workflow MUST NOT 将异步 consumer 的估计值标记为实际 KV writes。失败 run MUST 保留失败前已到达的最新聚合值。

#### Scenario: 当日预算已部分消耗
- **WHEN** planner selected 大于 coordinator logical grant
- **THEN** budget deferred 等于 candidates 减 logical grant，且 selected、granted、confirmed/uncertain 分别报告

#### Scenario: Queue 确认结果不确定
- **WHEN** fail-closed reservation 返回 uncertain outcome
- **THEN** logical grant 计入当日预算、uncertain 数量增加、confirmed 不增加，snapshot 仍可发布
