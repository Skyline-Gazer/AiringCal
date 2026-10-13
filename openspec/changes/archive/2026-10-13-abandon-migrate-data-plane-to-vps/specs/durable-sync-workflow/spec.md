## MODIFIED Requirements

### Requirement: 获取失败必须保留上一版正式快照
collections 或 calendar 获取最终失败时，VPS 同步任务 MUST 记录失败终态并保留上一版 PostgreSQL 权威数据和 R2 manifest。

#### Scenario: calendar 重试耗尽
- **WHEN** 收藏已完整获取但 calendar 最终失败
- **THEN** 任务以 failed 退出且不提交权威事务或公开 snapshot

### Requirement: Workflow 网络错误必须分类重试
同步运行时 MUST 将 401/403 视为终态认证错误，将 429、5xx、timeout 与网络错误按有界策略重试，并在耗尽后保留上一版公开数据。

#### Scenario: 上游鉴权失败
- **WHEN** bgm.tv 返回 401 或 403
- **THEN** 当前网络操作不重试且 run 记录脱敏认证错误

#### Scenario: 上游限流
- **WHEN** bgm.tv 返回 429
- **THEN** 当前网络操作按配置重试且不得覆盖上一版 manifest

### Requirement: Workflow 状态必须可观测
系统 MUST 在 PostgreSQL 持久化当前和最近同步 run 的阶段、心跳、终态、计数、耗时、git SHA 与脱敏错误，并由 health API 以兼容结构暴露应用状态。

#### Scenario: heartbeat 过期
- **WHEN** running run 超过约定窗口未更新 heartbeat
- **THEN** health 将其标记 stale 且保留 run ID 供 VPS 日志核对

#### Scenario: 初始化后尚未完成
- **WHEN** run 已获得 advisory lock 但尚未 finalize
- **THEN** health 可定位该 run 并返回其最后持久化阶段

### Requirement: live generation 必须单调提交
系统 MUST 使用 PostgreSQL 锁和 publication 状态单调分配 generation；只有完成 R2 snapshot 上传与回读验证的 run 才能切换 manifest。

#### Scenario: 较旧运行晚完成
- **WHEN** generation 1 在 generation 2 已切换后尝试发布
- **THEN** generation 1 返回 obsolete 且 manifest 仍指向 generation 2

#### Scenario: publication 中途失败
- **WHEN** snapshot 上传或回读校验失败
- **THEN** 本次 generation 不得成为公开 manifest

### Requirement: 定时同步必须按日运行
系统 MUST 使用 VPS 宿主机 cron 在每天 04:00 Asia/Shanghai 启动一次 Compose sync 任务，且不得保留 Cloudflare Worker Cron 作为常规业务调度源。

#### Scenario: 一个完整自然日
- **WHEN** VPS cron 正常运行
- **THEN** 系统只尝试一个 scheduled sync run，重叠触发由双层锁跳过

### Requirement: 未变化同步不得产生逐 subject 副作用
同步任务 MUST 在写入和媒体获取前筛除规范状态未变化且未到刷新时间的 subject；仅 run 状态与必要备份可更新。

#### Scenario: 所有 subject 稳定且未到期
- **WHEN** 每日任务完成 collections 与 calendar 抓取
- **THEN** 不产生逐 subject 数据更新或重复 R2 图片写入，公开 manifest 保持不变

### Requirement: 同步运行指标必须闭合
系统 MUST 分别记录 fetched、inserted、updated、confirmed_deleted、unchanged、media refreshed/failed、publication、backup 与 notification 结果；不得把计划数量标记为已完成副作用。

#### Scenario: backup 失败
- **WHEN** 数据与 snapshot 成功而 backup 失败
- **THEN** run 聚合计数保持实际完成值并以 partial 终态结束

## REMOVED Requirements

### Requirement: 同步必须由可恢复 Workflow 编排
**Reason**: Cloudflare Workflow 不再承载周期同步；恢复与重放由 PostgreSQL run/publication 状态和幂等的一次性 VPS 任务承担。
**Migration**: 使用 `vps-data-sync-runtime` 的 advisory lock、run 状态和 replay-safe publication。

### Requirement: Workflow step 必须确定且有界
**Reason**: VPS 任务不受 Worker invocation subrequest 限制，不再需要 Workflow step/staging 拆分。
**Migration**: 保留完整分页、有界重试和事务提交要求，但在单次容器运行中执行。

### Requirement: shadow 与 live 发布必须隔离
**Reason**: Cloudflare Workflow mode 被移除。
**Migration**: VPS CLI/配置提供 shadow publication，shadow 只生成比较对象且不得切换 `public/manifest.json`。
