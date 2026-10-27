## Why

止血只能降低当前 KV 写入，无法解决 KV 同时承担权威数据库、运行状态和公开快照所造成的长期写放大风险。系统需要把可变权威状态迁到写额度更充足的 D1，把不可变公开结果发布到独立 R2 数据桶，并将 KV 收缩为极少更新的发布指针。

## What Changes

- 创建或复用 D1 数据库 `airing-cal-state` 与独立 R2 bucket `airing-cal-data`，扩展 bootstrap、resource resolve、Wrangler materialization 和部署 migration 流程。
- 在 D1 建立 collection、subject media、sync run、daily budget 与 app state 五类权威状态。
- 每日完整读取 bgm.tv collections/calendar，在内存计算稳定内容 hash，只写新增、真实变化与确认删除的 D1 行。
- 对上游缺失采用两次成功全量读取确认，任一分页失败时不执行删除判定。
- 将 `watched` 作为 cold，其余收藏状态作为 hot；媒体调度使用优先级与 D1 原子预算预留。
- 生成单个版本化 `PublicSnapshotV1` JSON 到 R2；内容未变化时不写 R2、不增加 generation、不写 KV。
- 使用一次 KV PUT 发布 `PublicSnapshotPointerV1`，并保留旧 KV 读取路径供后续迁移 change 使用。

## Capabilities

### New Capabilities

- `incremental-state-store`: 定义 D1 权威收藏/媒体状态、稳定内容 hash、两次缺失确认和每日 QoS 预算。
- `immutable-public-snapshot`: 定义 R2 `PublicSnapshotV1`、内容寻址 key、校验与 KV pointer 原子发布协议。
- `cloudflare-state-resources`: 定义 D1 与独立 R2 数据桶的 bootstrap、解析、配置 materialization、migration 和部署顺序。

### Modified Capabilities

- `durable-sync-workflow`: Workflow 从版本化 KV staging/publish 改为 D1 增量提交与 R2 不可变发布，同时维持失败保留上一版语义。
- `cache-refresh-lifecycle`: subject media 权威状态与 QoS 从逐 subject KV 生命周期迁至 D1。
- `project-quality-gates`: 增加 D1 migration、R2 发布原子性、零变化零发布和资源配置验证。

## Impact

影响 Cloudflare bootstrap/resolve/deploy 脚本、三个内部 Worker 的 bindings、sync Workflow、media consumer、storage/domain 类型、D1 migrations、R2 snapshot writer、测试和部署文档。公开 HTTP API 暂不切换读取来源；现有图片仍留在 `airing-cal-images`，不复制二进制对象。
