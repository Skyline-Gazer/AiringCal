# VPS 数据平面运行手册

## PostgreSQL migration 前置条件

`apps/vps-sync` 仅使用标准 TLS `DATABASE_URL` 连接 PostgreSQL，且不使用供应商 SDK 或控制面 API。当前支持的 server baseline 是 PostgreSQL 18；运行环境必须保持在受维护的 `18.x` patch release。不得自动升级到未来 major，升级前必须完成显式兼容性评审和新的 real-server integration。PostgreSQL 17 compatibility 未验证，也不属于本次已批准 baseline 的验收门禁。

VPS 运行时组合入口只读取以下配置；它创建 Node `pg` authority 和 R2 的 S3-compatible port，再注入单次 `runOnce`。全部必填，不输出配置值，也不提供 scheduler 或其它运行模式。

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | direct/session-preserving PostgreSQL TLS connection。 |
| `R2_ENDPOINT` | R2 S3-compatible endpoint。 |
| `R2_BUCKET` | 存放 immutable snapshot 的 bucket。 |
| `R2_ACCESS_KEY_ID` | R2 S3 access key ID。 |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret access key。 |
| `R2_REGION` | R2 S3 signing region（通常为 `auto`）。 |

发布上传或回读失败会保留 PostgreSQL 中可重放的 pending publication；组合层只将该结果交给 coordinator 的既有脱敏 `runtime/STAGE_FAILED` 终态路径，绝不把 R2 错误内容持久化或通知。

迁移运行器在开始业务同步前执行，并先取得独立 PostgreSQL session advisory lock，随后才在锁内 bootstrap/校验 `schema_migrations`、读取 history 和应用 migration tail；未获得该锁会失败退出，不能执行任何 bootstrap DDL 或继续业务写入。`DATABASE_URL` 必须是 direct/session-preserving connection，不能使用 transaction pooling：advisory lock 属于数据库 session，事务池会在事务间切换 server connection。该要求同样适用于后续 migrations 以及计划中的 `pg_dump`/`pg_restore` 工作。

## PostgreSQL authority 写入边界

`PostgresAuthority` 是 VPS 运行时对 `users`、`subjects`、`collection_items`、`subject_media`、`calendar_entries`、`sync_runs` 与 `publications` 的唯一写入边界。构造 authority 时必须提供非空的 runtime secret 列表作为 persistence guard；调用方不得静默省略该列表。所有业务数据都通过参数化 SQL 和封闭的 normalized DTO 传入；repository 会在发起 query 前递归验证所有 JSON projection 的精确 nested keys、标量/枚举类型、有限数值和数组元素，而不依赖 TypeScript structural type。access/refresh token、数据库 URL、webhook URL/secret、R2 credentials、原始 authorization header、raw error/response shape 或未脱敏上游响应不得进入任何 text/JSON 列。

完整 collection/calendar 观察在单个数据库事务中提交：先建立 collection 与 calendar-only 条目共同引用的规范化 subject，再复用 domain `planCollectionDiff` 只持久化 inserts、真实 updates、first-missing、confirmed-deleted 与 restored 集合，随后替换 calendar 并 checkpoint run。事务内不得发生上游、R2 或其他网络调用。对同一 `(user_id, subject_id)`，首次完整缺失只设置 `missing_since` 和追踪用 `missing_run_id`；只有 `observed_at > missing_since` 的后续完整观察才设置 `deleted_at`，run identity 不参与确认判断。同一 run 的更晚观察可以确认删除，不同 run 的相同或更旧观察不能确认；重新观察到条目会清除 missing/deleted 状态。subject/collection 内容未改变时不执行对应写入。

`subject_media` 同时保存 `observed_at` 与 `observed_run_id` fence。较旧的 observation 不得覆盖 last-known-good detail、metadata 或 image references。publication 按 `live`/`shadow` 持久化隔离：每个 mode 各有一个 verified state 和至多一个 pending state，互不共享 generation、hash 或 object key。`savePendingPublication` 只保存 unclaimed candidate，`claimPendingPublication` 以 generation/hash/key/run identity 做条件 claim，exact replay 必须复用相同的 persisted `claimed_at` identity；`clearUnclaimedPending` 只在 verified generation/hash 仍与 no-change caller 一致时清除 unclaimed pending。claimed pending 不可替换或被 no-change cleanup 清除；verified promotion 必须匹配 pending 的 generation、hash、object key、run 与 `claimed_at`，未 claim、wrong-run 或 wrong-claim caller 均不得 promotion，并且 generation 只能前进一步。immutable object 的条件 PUT 若返回 412，仍必须完整回读并比较字节、解析 snapshot、校验 generation/hash/key；缺失、截断或不匹配时只保留可重放 pending，绝不写 manifest。

迁移集成验证采用 PostgreSQL 18 direct TLS server，并运行 fail-closed Node `pg` 门禁：

```sh
pnpm -F @airing-cal/vps-sync test:integration
```

该 suite 会创建随机隔离 schema，真实执行两个独立连接从完全空 schema 并发 cold-start migration、immutable `0001` → current upgrade、checksum/current-schema gate、session advisory lock、事务 rollback、calendar-only foreign key、canonical 删除/恢复与 unchanged-zero-write、media stale fence、publication claim/cleanup CAS，并扫描所有 text/JSON 列。secret probe 使用此前未出现的新 subject/hash 且不给 calendar 同 id projection，确保 marker 确实到达 persistence guard；全列扫描作为后续独立 subtest 执行并核对实际扫描列数。未配置 `DATABASE_URL` 时命令必须以 `DATABASE_URL_REQUIRED_FOR_POSTGRES_INTEGRATION` 失败，不得 skip 或以 recording fake 冒充通过。测试结束后 suite 删除随机 schema 并关闭 pool。

已执行证据：2026-08-31 在 PostgreSQL 18.6 direct TLS server 上，该命令退出 0（9 pass、0 fail、0 skipped、25,756.220958 ms）。开始/结束查询均确认 `new_remaining_test_schemas=[]`；suite 仅创建并删除随机 schema。完整范围、commit identity 和环境边界见 [PostgreSQL 18 integration evidence](../verification/2026-08-31-vps-sync-postgresql-18-integration.md)。文档不记录或示例化任何实际连接 URL、hostname、username 或 secret。

`psql` 不参与实现的 Node `pg` migration/lock 路径，因此此前 `psql` preflight 已由上述 real Node `pg` API test 对该路径的验收证据取代。Docker disposable instance、CI service 配置和 `psql --help` 均未执行，仍是单独的 container/CLI 前置检查；已核验官方 `postgres:18-alpine` tag 存在，但尚未将其用于本项目容器验证。2026-09-09 已在本机 Homebrew keg-only `libpq` 18.6 的绝对路径运行 `pg_dump --help`、`pg_restore --help`：前者确认 `--format=c|d|t|p`、`--file` 和 database/host/port/username 连接选项，后者确认 custom archive 输入及 database/host/port/username 连接选项；实现使用的 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE` 与 `PGSSLMODE` 隔离环境变量也已有自动测试。此仅为本机 CLI contract evidence，不代表已对真实 direct PostgreSQL target 执行 dump，亦不代表已完成 restore drill；两项仍 pending。

参考：<https://www.postgresql.org/docs/18/release-18.html>、<https://www.postgresql.org/docs/18/app-pgdump.html>、<https://neon.com/docs/connect/connection-pooling>。

## 上游完整抓取与重试

VPS 上游适配器以 `maxGetRetries: 0` 构造 `BgmClient`，每个 collection page 与 calendar 请求只由外层重试一次策略控制，最多总计 3 次请求。所有已配置用户的每一页和 calendar 都通过完整性边界后，才会产生可提交的完整观察；分页 total、offset、limit、页长度、重复 subject 或运行时 payload 结构异常都会 fail closed。

`pnpm -F @airing-cal/vps-sync build` 保留 `dist` 中原有的 PostgreSQL entry locations 与 migration SQL copy，并把 `dist/upstream/fetch.js` 及其 workspace runtime dependencies 打包为 Node ESM。该 emitted adapter 可由 plain Node 直接 import，不依赖仓库 TypeScript source 或开发 loader。

| 上游结果 | 处理 |
| --- | --- |
| 401 / 403 | 认证终态，不重试。 |
| collection 或 calendar 404 | 完整抓取终态，不把它当作空数据。 |
| 429、5xx、超时、网络错误 | 对当前请求最多尝试 3 次；有效 `Retry-After` 受最大延迟限制，否则使用有界指数退避和 jitter。 |
| JSON 或 schema 不合法、分页漂移或重复项 | contract 终态，不重试也不提交部分输入。 |
| retry delay 计算或等待失败 | 以 `contract:RETRY_DELAY_FAILED` 终态结束当前请求，不开始下一次上游请求。 |

上游错误只在后续运行结果中使用稳定的 category、code、stage 和 attempt；不得持久化或通知原始 URL、token、响应 body 或底层错误消息。完整观察时间沿用现有同步语义，使用 Unix 秒。

## 单轮协调器与媒体接口

媒体围栏、发布和备份使用完整输入的观察时间，而非进程启动时间，避免长分页抓取造成观察代次错位。

候选查询先按稳定优先级排序并筛除非本日 cold 分片，再应用数量上限；没有已观察围栏的媒体行仍可进入首次刷新。

初始化/锁/清理异常也只返回脱敏结果，清理一个资源失败仍会尝试其余清理。业务锁在连接池仍可用时先释放，因此 unlock 失败会进入同一份终态持久化、通知和返回结果；锁只尝试释放一次。若数据库初始化时已不可用，则无法保证持久化终态；连接池关闭失败时会尽力补写并重新通知修正后的终态，但连接池可能已经不可用。调用方必须记录返回的终态并采用对应非零退出码，不能仅依赖数据库中的最后记录判断进程是否健康。

权威事务返回已提交的 inserted、updated、unchanged、missing、deleted、restored 计数；协调器只在 COMMIT 成功后合并这些计数，不将计划条目数标成已完成写入。

媒体直接写入 `applyMediaResult` 与锁内写入均受同一 subject advisory lock 保护。锁内读取后会在 SQL mutation 前拒绝旧围栏；合并 last-known-good 后内容、hash、状态与重试/tombstone 时间均相同的记录不执行 UPDATE。锁生命周期之外保留的 save closure 不能继续写入。

`runOnce` 是端口注入的单轮协调器，接受 `shadow|live` 与 `scheduled|manual`。抓取端口返回已验证完整并保留 calendar 可选字段 presence 的 `CompleteFullFetch`；协调器先投影成严格 `CompleteStateInput` 再调用权威事务。同一 subject 的 calendar 实际提供字段优先，collection 只能补 calendar 缺失字段；双方都未提供 `name` 时，PostgreSQL authority JSON/hash 保持该字段缺失，own-property 显式空字符串则保留，旧 public collection shape 仅在 consumer 转换时补 `name: ''`。collection-only、calendar-only 与跨用户重复 subject 均保留，重复 collection subject 按配置用户顺序稳定选择。非完整抓取或未知用户在提交前拒绝，空收藏的配置用户仍写入投影以维持删除保护。协调器随后按媒体、发布、备份顺序运行；发布端口只有返回 `published` 或 `no_change` 才允许备份，媒体降级不阻止发布或备份。终态先写入 PostgreSQL 再调用通知端口，随后独立保存通知结果。锁竞争产生 persisted/notified `skipped`，不抓取上游或写 R2。`success/no_change/skipped` 映射退出码 0，`partial/failed` 映射 1。

## PostgreSQL backup 上传

运行时在发布成功或确认 `no_change` 后执行 `pg_dump --format=custom`。连接 URL 只被解析为子进程的 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE` 与受支持的 TLS 参数 `sslmode`（映射为 `PGSSLMODE`）环境变量，不进入 argv、R2 key、manifest、持久化结果或日志；其他 URL query 参数会在命令启动前以 `BACKUP_DATABASE_URL_INVALID` 拒绝。子进程会清除宿主环境中的全部 `PG*` 变量，避免它们改变该 URL 指定的目标。dump 写入受限的 `/tmp/airing-cal/backup-*` 目录；无论 dump、读取或任一上传成功与否，目录都会在 `finally` 中移除。

成功时先上传 `backups/postgres/YYYY/MM/DD/<timestamp>-<40-char-git-sha>.dump`，再上传同 stem 的 `.json`。manifest 是 canonical JSON，严格包含 `schema_version`、`run_id`、`git_sha`、`created_at`、`object_key`、`size`、`sha256`。R2 dump 或 manifest 上传失败不会撤销公开 snapshot；协调器会把 backup component 标为 failed，并将终态保留为 `partial`。retention、下载、checksum 回验、`pg_restore` 和真实恢复演练属于后续任务，当前没有实现。

每阶段开始和长阶段每 30 秒更新 heartbeat；阶段完成会取消并等待在途心跳。并行 heartbeat 失败记录为脱敏降级终态，但不会丢弃已经完成的 authority 计数、发布里程碑或阻止对应备份。若 notification 阶段本身的 heartbeat 在首次通知期间失败，协调器会在 timer drain 后发送一次无 heartbeat 的最终降级修正通知，不递归重试。最终释放业务锁与调用资源清理端口。上游可信错误保留 category/code/stage/attempt，未知异常只记录稳定 `runtime/STAGE_FAILED`，不复制异常消息。

## VPS 可选 Sentry tracing

VPS coordinator 可注入 `createNodeSentryTracing(process.env)` 生成的 SDK-neutral `TracingPort`。只有设置 `SENTRY_DSN` 才会初始化 `@sentry/node`；未设置时为 no-op，不初始化也不发送。`SENTRY_TRACES_SAMPLE_RATE` 必须是有限的 `[0, 1]` 数值，未设置默认为 `1`，无效值同样返回 no-op。

adapter 使用无默认 integrations 的 SDK 初始化并显式关闭 PII，因此不会自动产生 HTTP 或数据库 spans，也不会把 tracing header 传播到 bgm.tv、PostgreSQL、R2 或飞书。只会手工创建 root/stage spans，且只附带 mode、source、stage、终态 status、有限 count、duration 与合法 git SHA。它不 capture raw exception，也不附加 URL、body、username、subject/database ID 或任何 credential。

tracing 初始化、span 及 flush 均 fail-open：operation 保证只运行一次；协调器会在短命进程完成前尽力 flush，最多等待 2 秒。任何 tracing/flush 异常不得修改 business result、持久化/通知终态或进程退出码。此配置和 adapter 仅属于 VPS Node 路径，Cloudflare Workers 不依赖该 SDK。

## Public snapshot manifest V1

Domain 包现已提供 `PublicSnapshotManifestV1` 的严格构建与解析。不可变 snapshot key 固定为 `snapshots/v1/<generation>-<content_sha256>.json`；generation 为非负安全整数，hash 为 64 位小写 SHA-256。manifest 只接受以下字段，禁止缺失或额外字段：

```json
{
  "schema_version": 1,
  "generation": 7,
  "snapshot_key": "snapshots/v1/7-<64-character-lowercase-sha256>.json",
  "content_sha256": "<64-character-lowercase-sha256>",
  "published_at": "2024-07-26T13:20:00.000Z",
  "source_observed_at": "2024-07-26T13:20:01.000Z",
  "item_count": 42,
  "git_sha": "<40-character-lowercase-git-sha>"
}
```

`published_at` 由公开 snapshot 的 Unix 秒 `published_at` 转换为同一瞬间的 UTC ISO-8601；`source_observed_at` 同样必须是规范 UTC ISO-8601。`item_count` 来自 snapshot summary 的 `_total`。`canonicalSnapshotBytes` 保留公开 response envelope 的 canonical UTF-8 表示，而 business `content_hash` 继续排除 generation、发布时间和其他运行时噪声；因此同一业务内容在不同 wall-clock 时间仍会得到相同 hash。

Read Worker 的主读取路径只从 data R2 的精确 key `public/manifest.json` 读取公开 snapshot。它严格校验 manifest 的 keys、schema、时间、git SHA、generation、snapshot key、hash 与 item count，再读取 manifest 指向的不可变对象并复用 `PublicSnapshotV1` parser 校验 payload。每次成功读取会把完整 `{ manifest, snapshot }` envelope 写入 Cache API：generation/hash 绑定的 key 用于隔离对象，`last-verified` entry 只保存完整已验证 pair。主 R2 缺失、损坏或不可用时重新校验该 envelope；manifest generation 回退或同 generation 不同 hash 时继续服务较新的 envelope。没有有效 envelope 才回退到完整 legacy KV snapshot，绝不混用不同来源的 manifest、payload 或字段。health 的 snapshot source 因此报告 `r2`、`cache` 或 `legacy`。公开 URL、查询参数和响应 shape 不变；读取过程不访问 VPS 或 PostgreSQL。

`refreshMedia` 使用最多 4 个并行 subject，按新条目/变化、hot、cold、retry 排序，cold 按 subject ID 的星期分片选择。PostgreSQL `withSubject` 在同一 session 持锁读取围栏、执行图片上传和保存引用；过期、同观察时间重放和未到失败 retry/tombstone 时间的记录不抓取。成功刷新采用原有 6–8 天确定性分散；authority 确认的变化可以提前刷新已成功的记录，健康未变化记录仍等待周期到期。候选 SQL 与锁内检查均保留失败一小时重试、明确 404 一天 tombstone 的边界，并保留成功数据。

图片接收只允许受支持的 HTTPS bgm 图片主机、HTTP 200、JPEG/PNG/WebP/GIF/AVIF MIME，流式读取最多 8 MiB。SHA-256 相同且命名空间匹配时复用对象；shadow 只 PUT `shadow/images/`，live 只 PUT `images/`。新对象上传成功后才保存引用，各尺寸独立保留最后成功值。缺少图片来源不影响 detail/metadata 成功；下载、校验或上传失败不会清空旧图。

## 不可逆策略与回退

SQL migrations 仅可向前应用。已发布的 `0001_initial.sql` 固定为 Task 1.1 commit `a55b17718387c83067c4e1f7a34bd4d6d049d10f` 的逐字节内容（SHA-256 `cd06c6a655aee9762095de384407e584a2340ad9b7a5a17b027adb966337486f`）；run observation fences 从 `0002_authority_constraints.sql` 起追加，禁止重写 `0001`。`schema_migrations` 保存 migration 文件名、SHA-256 checksum 和应用时间；任何已应用 migration 的 checksum 改变都会以 `MIGRATION_CHECKSUM_MISMATCH` 终止，非有序前缀历史以 `MIGRATION_HISTORY_GAP` 终止，数据库出现当前镜像不认识的 migration 时以 `MIGRATION_SCHEMA_AHEAD` 终止。migration 命令只从合法前缀应用尾部；业务启动必须调用 `assertCurrentSchema`，schema behind 或 ahead 均不得继续业务工作。

回退应部署仍兼容当前 schema 的已知镜像，或恢复经验证的数据库备份；不得反向执行 migration，也不得删除已应用 migration 记录。
