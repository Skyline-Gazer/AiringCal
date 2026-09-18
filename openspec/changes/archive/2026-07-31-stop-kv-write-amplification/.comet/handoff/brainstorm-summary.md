# Brainstorm Summary

- Change: stop-kv-write-amplification
- Date: 2026-07-22

## 确认的技术方案

- 目标是严格保持 Cloudflare Free Plan，业务新鲜度按日计算。
- Scheduled sync 每日 04:00 Asia/Shanghai 运行。
- 常规媒体缓存按 subject ID 分散到 6 至 8 天刷新。
- 每日媒体 soft limit 50、hard limit 100；新增/变化优先于 hot 到期、cold shard 和重试。
- Workflow 在 enqueue 前读取组件状态、筛除完整且未到期的 subject，并按优先级和预算生成有界任务。
- Media consumer 只在规范内容或真实状态发生变化时写 refresh、metadata、image status。
- manual live 与 scheduled live 共享同一个 UTC 自然日预算，不提供绕过 hard limit 的 force 参数；shadow 不投递媒体任务。
- 用户确认 Queue 歧义采用 fail-closed：占用 coordinator 实际 UTC 日预算、每个稳定 reservation 最多一次 producer attempt、不重发，snapshot 继续发布；未确认媒体由次日重新规划。
- 用户要求 TDD、充分验证、每个原子步骤 commit and push，最终上线。

## 关键取舍与风险

- 增加 KV reads 来换取数量级更低的 writes；当前规模仍远低于 Free Plan read quota。
- 日预算不依赖 Cloudflare 实时配额 API，而由确定性日键和现有低写状态表达；核心 D1 原子预算留给后续 change。
- Queue/DO 无分布式事务，严格 hard ceiling 与歧义失败自动重试不可兼得；选择 hard ceiling，接受当日可能少投递。
- Workflow step 的 external operations 必须继续有界，不能在单 step 展开全部 subject。

## 测试策略

- 先写 659 个未变化 subject 的失败测试，再实现筛选。
- 覆盖组件缺失、到期边界、soft/hard limit、优先级、cold shard、Workflow replay 和 consumer no-op write。
- 运行 sync/media/storage focused tests、全仓 typecheck/test/build、Wrangler dry-run 和生产 24 小时指标检查。

## Spec Patch

- 已回写 delta spec：manual live 与 scheduled live 共享同一个 UTC 日期预算；预算耗尽时 live 仍发布收藏快照；shadow 始终不投递媒体任务。
