## Context

D1/R2 核心完成后，旧 KV snapshot 仍服务公开 API，legacy detail/meta/image 状态也尚未迁移。直接切换会有投影缺失与回滚风险，因此需要可恢复导入、连续 shadow 等价验证和延迟清理。

## Goals / Non-Goals

**Goals:**

- 幂等、分批导入当前 subject 的 legacy metadata，复用现有图片对象。
- 连续 7 次日同步验证 R2 snapshot 与旧公开结果等价。
- 安全切换 Read Worker，并保留缓存和旧 KV 双层 fallback。
- 稳定 14 天后以每日小批次清理 legacy key。

**Non-Goals:**

- 不重新抓取全部图片，不复制 R2 图片。
- 不改变公开 HTTP URL、分页参数或响应 shape。
- 不在迁移期间双写 legacy 逐 subject KV。

## Decisions

1. 迁移对象来自当前 D1 收藏 subject 集合，每批最多 50；游标、成功/跳过/失败计数保存在 `app_state`，D1 已有更新状态时跳过 legacy 值。
2. shadow 比较规范化公开结果而非原始存储 JSON，覆盖五类 subject ID/字段、calendar、summary、图片与 NSFW，并记录连续成功次数。
3. 只有连续 7 次成功且每日 KV 写入达标才允许写 `public:current`。失败重置连续计数，但不删除已生成 R2 对象。
4. Read Worker 验证 pointer、schema、generation 和 hash；失败时先使用 Cache API 中最后验证版本，再回退旧 KV manifest。
5. 切换后 14 天内旧 KV 只读；清理每天最多 100 key，保留至少一个可回滚 generation。

## Risks / Trade-offs

- [legacy 状态不完整] → 缺失项记录为待正常媒体轮转补全，不阻塞其余迁移。
- [shadow 差异被排序噪声触发] → 比较前按稳定 key 排序并剔除运行时间字段。
- [R2 暂时不可用] → 最后验证缓存与旧 KV fallback 保证服务连续性。
- [清理后回滚能力下降] → 14 天观察期结束后才清理，且回滚依赖 R2 generation 而非已删 legacy metadata。

## Migration Plan

部署兼容读取与 migration runner，完成 metadata 导入；运行至少 7 次 shadow；满足门禁后切 pointer；观察 14 天再启用限速清理。任一阶段可关闭新读取并回到旧 KV，不回滚 D1 数据。

## Open Questions

无。
