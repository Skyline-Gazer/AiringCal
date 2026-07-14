## Context

当前同步先把失败账户映射为空数组，再在 primary 模式选取主账户结果；收藏和日历分别写入 KV。Cron 与 HTTP 手动触发可并发执行，token 刷新也没有互斥边界。

## Goals / Non-Goals

**Goals:**

- 任何失败都不得把有效主账户数据覆盖为空。
- 一次同步只发布完整结果，并避免重叠执行。
- 将管理端“完整同步”改为准确的复制语义。

**Non-Goals:**

- 不做双向冲突解决。
- 不自动删除目标账户独有条目。

## Decisions

- primary 模式单独检查对应 `PromiseSettledResult`，失败即终止。
- 将收藏、日历和元数据写为单个版本化快照 key，公开 API 先读取当前快照；避免跨 key 半更新。
- 同步互斥优先采用最小可行的单执行协调机制；若 Workers KV 无法提供所需原子性，则使用一个小型 Durable Object，而不是伪造 KV 锁。
- `tokenStatus` 返回明确状态：有效、无效、探测失败；只有前两者中的刷新条件可消费 refresh token。
- 管理端动作命名为“复制全部条目”与“复制选中条目”，服务端做严格请求校验。

## Risks / Trade-offs

- [引入 Durable Object 增加配置] → 仅在无法用现有平台保证互斥时使用，保持单对象单职责。
- [快照 key 迁移导致首次读取差异] → 读取端提供旧 key 的短期兼容回退，首次成功同步后切换。

## Migration Plan

先部署兼容读取，再执行一次同步生成新快照，确认健康状态后移除旧写入。回滚时旧 key 保持可读。

## Open Questions

深度设计阶段根据 Cloudflare 当前能力确认互斥实现及旧 key 兼容周期。
