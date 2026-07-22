## Why

生产 KV 每四小时出现一次与 Cron 完全一致的读写尖峰，月内写入已远超 Workers KV Free Plan 的每日额度。根因是每轮同步无条件为全部收藏与 calendar subject 创建媒体任务，并重复覆盖未变化的 refresh、metadata 与 image 状态；必须先独立止血，避免后续架构迁移期间继续耗尽配额。

## What Changes

- 将业务 Cron 从每四小时一次改为每天 04:00（Asia/Shanghai）一次。
- 恢复 subject detail/media 的 6 至 8 天确定性到期判断，未到期且缓存完整的 subject 不进入 Media Queue。
- 对 refresh、metadata 与 image 状态实施相同内容零写入，禁止仅因新 Workflow instance 而覆盖缓存。
- 引入每日媒体任务 QoS：新增或发生变化的条目优先，其次为 hot 到期条目、cold 七日轮转条目与失败重试；soft limit 50、hard limit 100。
- 补充 KV 写放大回归测试、运行指标和止血运维文档。

## Capabilities

### New Capabilities

- `sync-write-budget`: 定义每日同步与媒体刷新在 Free Plan 下的写入预算、任务优先级和预算耗尽行为。

### Modified Capabilities

- `durable-sync-workflow`: 将 schedule 改为日频，并要求未变化输入不产生逐 subject 副作用。
- `cache-refresh-lifecycle`: 恢复 6 至 8 天到期筛选、相同内容零写入和有界媒体调度。
- `project-quality-gates`: 增加无变化大批量同步不得产生逐 subject KV 写入的自动检查，并同步 Cron 文档约束。

## Impact

影响 sync-worker Workflow 与 Cron 配置、media-worker 的刷新判定、共享 storage/domain helper、相关测试和 README。公开 HTTP API 与现有 KV key 读取契约保持兼容；本 change 不引入 D1、不切换 R2 快照读取，也不清理旧 KV 数据。
