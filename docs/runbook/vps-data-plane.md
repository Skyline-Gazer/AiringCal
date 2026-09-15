# VPS 数据平面运行手册

## PostgreSQL migration

`@airing-cal/vps-sync` 使用标准 `DATABASE_URL` 连接 PostgreSQL。migration 按文件名顺序前向执行；已记录 migration 的 SHA-256 必须与 SQL 文件一致。发现 checksum 不一致、数据库包含应用不认识的 migration，或 migration 历史缺口时会拒绝继续。migration 不提供回滚或删除已应用 schema 的操作。

集成测试只对 disposable PostgreSQL 执行。先在独立终端启动 PostgreSQL 17：

```sh
docker run --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
```

随后设置测试专用连接与显式开关；测试会创建并删除随机 schema，不会使用默认 schema：

```sh
DATABASE_URL=postgres://postgres:test@127.0.0.1:54329/postgres VPS_SYNC_TEST_DATABASE=1 pnpm -F @airing-cal/vps-sync test -- src/postgres/migrate.test.ts
```

未配置 disposable PostgreSQL 或 `VPS_SYNC_TEST_DATABASE=1` 时，迁移集成测试会跳过。Docker 缺失不是跳过 checksum/advisory-lock 集成门槛的理由；请在具备该前置条件的 CI 或开发环境执行。

## 规范化 authority

`PostgresAuthority` 接收通过 `DATABASE_URL` 创建的 `pg.Pool` 和运行时 secret 值列表。`0001_initial.sql` 创建 `users`、`subjects`、`collection_items`、`subject_media`、`calendar_entries`、`sync_runs`、`publications`；`0002_media_component_state.sql` 为 `subject_media` 增加仅含 allow-listed component status、metadata 与 hash 的 JSONB 列。保持 `0001` 不变；旧媒体行继续从原聚合列推导组件状态。这些是尚未部署的 migrations；若开发数据库已应用旧占位版本，checksum 校验会拒绝它，测试应使用新的 disposable schema，不能修改数据库中的 checksum 绕过校验。

`beginRun` 记录 run identity、source、mode、git SHA 和 Unix 秒观察时间。`commitCompleteState` 接受全部配置用户的完整结果和完整日历；用户缺失、重复 subject、重复收藏、非法日历或 incomplete 标记均会拒绝写入。调用方先完成分页与 upstream contract 校验，再提交已归一化数据。事务用 advisory lock 串行化，subjects/collections 的 upsert、日历替换及 run checkpoint 一起提交或回滚；未变化的 subject 与日历行不重写，collection 结果分别报告 inserted、updated、unchanged；事务期间仅访问 PostgreSQL。

收藏使用 `(user_id, subject_id)` 主键。第一次完整缺失观察记录 `missing_since`，只有更晚的一次完整缺失观察才写 `deleted_at`；同一个 run 重放不会推进删除。重新观察到条目会清除两个标记。顺序与 `packages/domain/src/collection-diff.ts` 的规则一致，没有独立缺失次数计数器。

`listDueMedia` 按重试/刷新时间、subject ID 返回到期候选。`applyMediaResult` 用 subject 行锁和 `(observed_at, run_id)` 栅栏拒绝旧结果；时间相同时 run ID 使用固定字典序。调用方应复用已注册 run 的观察时间。失败或 404 保留最近成功的 detail/image 引用，记录重试或 tombstone 时间；成功结果只能写入与 hash 一致的 `images/<hash>/original` 或 `shadow/images/<hash>/original` 引用。

`publications` 只允许一行，内含 verified 与至多一个 pending。`savePendingPublication` 只接受下一代 generation；精确候选支持 replay，未被 claim 的候选允许由更新观察替换。`claim`/`release` 必须使用同一完整候选；`verifyPublication` 仅提升已 claim 且身份一致的 pending，已验证候选可幂等重放。相同 verified hash 返回 `no_change`，只清理未 claim 且不晚于当前观察的 pending。这里的 object key 是不带部署命名空间的逻辑 key；外部发布调用方负责选择 live/shadow 命名空间。

## 一次性同步与媒体生命周期

`runOnce` 通过端口注入依赖，按 lock → complete collection/calendar fetch → complete-state commit → media refresh → publication → backup → notification 顺序执行。每个阶段先更新 heartbeat；锁未取得时只记录并通知 `skipped`，不调用上游、媒体或发布写入。完整抓取失败不会提交 authority state；媒体的 detail、metadata 与 image 独立处理，瞬态失败保留最后成功引用并使本轮为 `partial`。只有明确的 detail `null` 才创建 24 小时 tombstone；detail 网络/服务端失败会清除已过期 tombstone 并在一小时后重试。图片 429、5xx 响应或 fetch 超时/网络错误也在一小时后重试；无效图片内容保留正常刷新调度。终态为 `success`、`no_change`、`skipped` 时进程退出码为 0，`partial` 与 `failed` 为非零。

媒体刷新按 `new_or_changed → hot → cold → retry` 的稳定优先级和 subject ID 排序，cold 使用 UTC 星期分片，并固定最多四个并发 subject。每个 subject 的 PostgreSQL 行锁覆盖上游读取、图片校验、R2 PUT 与引用提交；图片只接受 HTTPS 白名单 host、200 与允许 MIME，限制 8 MiB 后计算 SHA-256，先写对象再保存引用。shadow 对象使用 `shadow/images/<sha256>/original`，相同 hash/key 复用对象。

## R2 snapshot manifest

发布使用精确字段的 `PublicSnapshotManifestV1`，snapshot key 固定为 `snapshots/v1/<generation>-<content_hash>.json`。`content_sha256` 与 snapshot 的 business `content_hash` 相同；`published_at` 将 snapshot 的 Unix 秒时间编码为 UTC ISO-8601，`source_observed_at` 编码本轮观察时间。`item_count` 等于 snapshot 的 `summary._total`，`git_sha` 是完整的 40 位小写 commit SHA。

```json
{
  "schema_version": 1,
  "generation": 9,
  "snapshot_key": "snapshots/v1/9-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
  "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "published_at": "2026-09-15T00:00:00.000Z",
  "source_observed_at": "2026-09-15T00:01:00.000Z",
  "item_count": 1,
  "git_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

## 上游完整抓取与重试

VPS 适配器使用 `maxGetRetries: 0` 构造 `BgmClient`，每个 collection 分页请求和 calendar 请求只由外层 retry 处理，最多三次尝试。所有配置用户的分页和 calendar 通过完整性校验后，才会生成可提交的 `CompleteFullFetch`；primary user、任一分页或 calendar 不完整都会 fail closed。

| 上游结果 | 处理 |
| --- | --- |
| 401 / 403 | 认证终态，一次失败，不重试。 |
| collection / calendar 404 | `not_found` 终态，不当作空数据。 |
| 429、5xx、超时、网络错误 | 最多三次外层尝试；`BgmClient` 仅透传响应的 `Retry-After` header 值，合法值受最大延迟限制，否则使用有界指数退避和 jitter。 |
| invalid JSON、schema mismatch、分页漂移或重复项 | `contract` 终态，不返回完整输入。 |

持久化/通知只使用稳定的 `category`、`code`、`stage` 和 `attempt`，不携带 token、URL、响应 body 或底层异常消息。

## Secret 禁存与测试

数据库只保存明确列出的业务字段；额外 upstream 属性、raw response、authorization、token、webhook 和连接配置不写入 JSON。初始化 authority 时必须传入运行时凭据值列表，所有可持久化自由文本/JSON 都会检查这些值；发现匹配即在写入前拒绝。通用 PostgreSQL URL、Bearer header、带密码 URL 也会被拒绝。错误持久化只接受稳定类别，未知错误映射为 `UNKNOWN`，不会存异常消息。`finishRun` 通过固定字段记录终态、组件结果、媒体计数与阶段耗时；通知结果可更新，但不能改写已结束 run 的业务状态、publication 或 backup 结果。

仓储测试沿用 `VPS_SYNC_TEST_DATABASE=1` 与 disposable `DATABASE_URL`。运行包测试会同时覆盖 migration 与 repository；CI 的 PostgreSQL 17 service 已启用上述变量。数据库断言包括完整 rollback、两次缺失/恢复、媒体 fence、publication pending/replay/claim/generation 冲突，以及遍历测试 schema 所有 text/json 列的 secret 扫描。缺少本地数据库时这些断言明确标记 skipped，不能以单元测试通过替代。
