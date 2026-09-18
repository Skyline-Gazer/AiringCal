# Brainstorm Summary

- Change: `adopt-d1-r2-incremental-sync`
- Date: 2026-07-26

## 确认的技术方案

- 每天 04:00 Asia/Shanghai 完整读取 bgm.tv collections 与 calendar；上游没有可靠增量游标，因此在内存中以规范业务字段的稳定 SHA-256 与 D1 当前行做 diff。
- D1 `airing-cal-state` 是可变权威状态，使用 `collection_items`、`subject_media`、`sync_runs`、`sync_budget`、`app_state` 五张表；首版不建二级索引。
- 只写新增、业务 hash 变化和合法状态转换。首次成功全量读取缺失只记录 `missing_since`，下一次成功全量仍缺失才确认删除；任一分页失败都不推进删除。
- `watched` 是 cold，按 `subject_id mod 7` 七日轮转；其余收藏状态是 hot。媒体工作按新增/变化、hot 到期、cold shard、retry 排序，并在 D1 原子预留每日预算。
- 独立 R2 bucket `airing-cal-data` 保存不可变 `PublicSnapshotV1` 单对象；现有 `airing-cal-images` 只保存图片且不复制已有二进制。
- 规范公开内容 hash 排除 generation 和发布时间。内容不变时 D1 收藏行写入为零、R2 PUT 为零、generation 不变、KV PUT 为零。
- 发布顺序固定为 D1 commit → R2 PUT → R2 回读校验 → 单次 KV PUT 更新 `public:current`。任一步失败均保留旧 pointer。
- 本 change 只部署 D1/R2 核心与 shadow publication，不切换公开 API 读取来源；读取切换、旧 KV 导入、七次一致性门禁和清理由后续 `migrate-public-reads-from-kv` change 完成。
- Cloudflare 资源与运行时代码采用兼容的分段部署：先扩展并运行 bootstrap/resolve，再提交 D1 binding、migration 与运行时代码，避免中间 SHA 因资源缺失无法部署。

## 关键取舍与风险

- 当前几百到几千条收藏下，D1 全表读取比为低基数字段维护索引更节省写入；规模达到数万条后再依据指标决定索引。
- D1 与 R2 不支持跨资源事务，因此以 pointer-last 协议保证读取端只见已验证对象；D1 已提交但 R2 失败时保留可重试的未发布状态。
- QoS 使用 fail-closed 语义：预算预留后若媒体提交结果不确定，不释放名额也不重复发送；媒体失败不阻塞收藏 diff 或 snapshot 发布。
- 第一版每天最多处理 100 个媒体任务，不在同一天因媒体补全再发布第二个公开 snapshot；媒体结果在下一次日同步进入公开投影。
- D1 migration 必须先于任何依赖新 binding 的 Worker 发布；resource resolve 在上传前验证 D1、两个 R2 bucket、KV 与 Queue。

## 测试策略

- 使用 TDD 覆盖稳定规范 JSON/hash、行 mapping、完全相同输入零 D1 收藏写、业务字段变化单行写、两次缺失确认及分页失败保护。
- 使用并发测试证明 D1 每日预算原子预留不超过 hard limit，并覆盖优先级延后、cold 七日覆盖和 fail-closed 重放。
- 使用 failure injection 覆盖 D1、R2 PUT、R2 回读校验和 KV pointer 任一步失败，证明旧 generation 始终可服务。
- 使用 replay 测试证明相同输入第二次产生零 R2 PUT、零 KV PUT且不增加 generation。
- 验证 bootstrap/resolve/materialize、D1 migrations、Wrangler dry-run、全仓 typecheck/test/build，并在生产以 shadow 模式检查 D1/R2 指标。

## Spec Patch

无。当前 delta specs 已覆盖 D1 权威状态、稳定 diff、两次缺失确认、原子 QoS、不可变 R2 snapshot、pointer-last 发布、资源 bootstrap 与部署门禁。
