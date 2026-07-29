## Context

止血后 KV 仍同时承载权威缓存、运行状态、Workflow staging 与公开 snapshot。目标架构以 D1 保存可变状态、R2 保存可重建的不可变公开产物，KV 只保存 active pointer；公开读取切换由后续 change 完成。

## Goals / Non-Goals

**Goals:**

- 建立 D1 权威模型、稳定 diff、两次缺失确认和原子 QoS 预算。
- 内容变化时发布单个可验证 R2 snapshot，并以一次 KV 写切换 pointer。
- 扩展 Cloudflare bootstrap、bindings、migration 与部署门禁。

**Non-Goals:**

- 不切换现有公开 API 的读取来源。
- 不导入或删除 legacy KV metadata。
- 不复制现有图片对象，不做同日媒体完成后的二次发布。

## Decisions

1. D1 使用 `collection_items`、`subject_media`、`sync_runs`、`sync_budget`、`app_state` 五张表且首版不建二级索引；当前数据量全表扫描更省写。
2. 收藏 hash 只覆盖规范业务字段；运行时间与 generation 不参与。每次成功全量读取在内存 diff，只写新增、变化或缺失状态转换。
3. 删除采用两次成功全量读取确认；任何分页失败时不提交删除标记。
4. R2 使用独立 `airing-cal-data` bucket，单对象 key 为 `snapshots/v1/{generation}-{content_hash}.json`。规范 payload hash 未变化时完全不发布。
5. 发布顺序为 D1 commit、R2 put、R2 回读校验、KV pointer put。旧 pointer 始终保持可服务。
6. `sync_budget` 在 D1 事务中预留资源；媒体失败或预算耗尽不得阻塞收藏状态与 snapshot 发布。
7. resource bootstrap 与运行时代码分两次兼容部署；D1 migration 必须先于 read/media/sync Worker 发布。
8. D1-only media 使用独立 V4 job discriminator；既有 live Workflow V3 保持 legacy KV 写入，使当前 Read Worker 与下一轮 planner 能观察刷新结果。

## Risks / Trade-offs

- [D1 与 R2 在发布窗口短暂不同步] → pointer 最后切换，读取方只接受 pointer 指向且校验通过的对象。
- [全表读取随规模增长] → 当前几千条假设下低于 D1 免费读额度；达到数万条后再以指标决定索引。
- [新资源未 bootstrap 导致部署失败] → resolve job 在上传前失败并给出手动 bootstrap 指令。
- [D1 commit 后 R2 失败] → app state 保留未发布状态，下一轮以相同内容重试，旧 pointer 不变。

## Migration Plan

先提交 bootstrap/resolve 支持并手动创建资源，再提交 schema/bindings 和 migration，随后部署 D1 增量 Workflow 与 shadow R2 writer。旧 KV snapshot 仍是公开读取来源，因此核心回滚只需部署上一兼容 SHA；D1/R2 新数据保留。

## Open Questions

无。
