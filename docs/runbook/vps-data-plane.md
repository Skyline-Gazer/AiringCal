# VPS 数据平面运行手册

## 当前运行边界

本手册描述已提交并可审计的 VPS 组件，不代表生产 shadow、restore drill 或
cutover 已执行。`deploy/vps/run-sync.sh` 只在宿主机取得非阻塞 `flock` 后启动
一次 Compose `sync`；它不发布镜像、不部署 VPS、不切换公开 manifest，也不自动
清理旧 Cloudflare 资源。live 运行需要单独的人工批准和后续迁移门禁。

`apps/vps-sync/src/cli.ts` 提供 process-facing `sync` 入口和四个带门禁的迁移操作：

```text
Usage: sync [--mode=shadow|live] [--source=scheduled|manual]
```

`applyMigrations(pool)`、`createBackup(deps, run)` 和
`restoreVerify(deps, key, targetUrl)` 仍是注入式 API；`migrate`、`backup` 尚无独立
CLI。Task 9.3 的操作入口只接受已验证的非 secret 参数，实际 PostgreSQL、R2 和
Cloudflare control-plane port 必须由部署 adapter 注入；没有 runner 时进程直接
fail closed，不会连接生产服务。

```text
Usage: shadow-compare --mode=shadow [--dry-run]
Usage: restore-verify --backup-key=<r2-key> --target-env=<env-name> [--dry-run]
Usage: cutover --mode=live --approval-token-env=<env-name> [--dry-run]
Usage: rollback --mode=live --manifest-key=<r2-key> [--dry-run]
```

`shadow-compare` 只把 immutable snapshot 和 manifest 写入
`shadow/<snapshot-key>`、`shadow/manifest.json`，并返回 JSON-pointer 字段级 diff；
`--dry-run` 只验证 manifest/snapshot pair 和比较输入，不写 R2。`restore-verify`
的 `--backup-key` 是 R2 key，`--target-env` 是环境变量名（例如
`RESTORE_DATABASE_URL`），不是数据库 URL；目标 URL 只能由注入式 adapter 读入内存，
并继续经过空库、非 production identity 和 `pg_restore` 校验。cutover 必须使用
`--approval-token-env` 指向环境变量名且 token 非空；rollback 只能使用已验证的
manifest/snapshot envelope。两者的 `--dry-run` 都只产出证据模板，不写
`public/manifest.json`。操作不会停止 scheduler、修改数据库 schema、删除 R2/Cloudflare
资源或执行真实生产切流。

Compose 使用的环境变量如下；`.env.example` 只是占位模板，真实 `.env` 必须
由 cron 用户私有保存并设置 `chmod 600`：

| 变量 | 必填 | 语义 |
| --- | --- | --- |
| `VPS_SYNC_IMAGE` | 是 | 完整 40 位 git SHA production image |
| `DATABASE_URL` | 是 | PostgreSQL connection URI |
| `BANGUMI_TOKEN` / `BANGUMI_USERS` | 是 | bgm.tv token / 逗号分隔用户名 |
| `R2_ENDPOINT` / `R2_BUCKET` | 是 | R2 S3 endpoint / bucket |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 是 | R2 凭据 |
| `FEISHU_WEBHOOK_URL` | 是 | HTTPS Feishu custom-bot webhook |
| `FEISHU_WEBHOOK_TOKEN` / `FEISHU_WEBHOOK_SECRET` | 否 | query token / HMAC secret |
| `FEISHU_TIMEOUT_MS` | 否 | 默认 `10000`，最大 `60000` |

`FEISHU_WEBHOOK_URL`、token、secret、数据库 URI 与 R2 凭据不会进入 argv、日志、
backup manifest 或通知正文。完整组件边界见
[VPS 架构文档](../architecture/vps-data-plane.md)。

## vps-sync Alpine 镜像

`Dockerfile.vps-sync` 提供 `production` 与 `debug` 两个目标。构建阶段使用仓库锁文件和 `pnpm@9.15.9`，调用 `pnpm -F @airing-cal/vps-sync build`；production 只带编译后的 `dist/`、production dependencies、`ca-certificates` 和 `postgresql17-client`，以 `node` 用户执行 `node dist/cli.js`，不声明监听端口。debug 从 production 继承并额外安装 `curl`、`bind-tools`、`netcat-openbsd`、`procps-ng`、`iproute2` 与 `jq`；这些目标包名待 Docker 环境用 `apk search` 重跑确认。read-only root filesystem、capability drop、tmpfs 和无端口映射由 Task 7.2 Compose 约束。

静态契约检查：

```sh
node --test scripts/verify-vps-sync-image.test.mjs
node scripts/verify-vps-sync-image.mjs
```

具备 Docker 的环境还应先运行 `docker buildx imagetools inspect node:alpine`、在临时 `node:alpine` 容器中运行 `apk search` 核验包名，再运行 `docker buildx build --help` 核验构建参数；构建后将实际 Node/Alpine 版本与 base digest 记录到 CI 审计元数据。Task 7.1 执行环境没有 Docker CLI（上述三类命令均为 `command not found`），因此本任务没有声称完成镜像拉取、构建或运行时检查。fallback 依据 Docker 官方 [`node` 镜像说明](https://hub.docker.com/_/node) 与 Alpine 官方 [`postgresql17-client` 包索引](https://pkgs.alpinelinux.org/package/v3.24/main/x86_64/postgresql17-client)核对基础镜像/最小 PostgreSQL 客户端名称；debug 包名仍需在具备 Docker 的环境中用目标 `node:alpine` 的 `apk search` 重跑确认。

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

`PostgresAuthority` 接收通过 `DATABASE_URL` 创建的 `pg.Pool` 和运行时 secret 值列表。`0001_initial.sql` 创建 `users`、`subjects`、`collection_items`、`subject_media`、`calendar_entries`、`sync_runs`、`publications`；`0002_media_component_state.sql` 为 `subject_media` 增加仅含 allow-listed component status、metadata 与 hash 的 JSONB 列；`0003_notification_failed.sql` 为 `sync_runs` 增加可空的独立通知失败摘要 JSONB 列。保持 `0001` 不变；旧媒体行继续从原聚合列推导组件状态。这些是尚未部署的 migrations；若开发数据库已应用旧占位版本，checksum 校验会拒绝它，测试应使用新的 disposable schema，不能修改数据库中的 checksum 绕过校验。

`beginRun` 记录 run identity、source、mode、git SHA 和 Unix 秒观察时间。`commitCompleteState` 接受全部配置用户的完整结果和完整日历；用户缺失、重复 subject、重复收藏、非法日历或 incomplete 标记均会拒绝写入。调用方先完成分页与 upstream contract 校验，再提交已归一化数据。事务用 advisory lock 串行化，subjects/collections 的 upsert、日历替换及 run checkpoint 一起提交或回滚；未变化的 subject 与日历行不重写，collection 结果分别报告 inserted、updated、unchanged；事务期间仅访问 PostgreSQL。

收藏使用 `(user_id, subject_id)` 主键。第一次完整缺失观察记录 `missing_since`，只有更晚的一次完整缺失观察才写 `deleted_at`；同一个 run 重放不会推进删除。重新观察到条目会清除两个标记。顺序与 `packages/domain/src/collection-diff.ts` 的规则一致，没有独立缺失次数计数器。

`listDueMedia` 按重试/刷新时间、subject ID 返回到期候选。`applyMediaResult` 用 subject 行锁和 `(observed_at, run_id)` 栅栏拒绝旧结果；时间相同时 run ID 使用固定字典序。调用方应复用已注册 run 的观察时间。失败或 404 保留最近成功的 detail/image 引用，记录重试或 tombstone 时间；成功结果只能写入与 hash 一致的 `images/<hash>/original` 或 `shadow/images/<hash>/original` 引用。

`publications` 只允许一行，内含 verified 与至多一个 pending。`savePendingPublication` 只接受下一代 generation；精确候选支持 replay，未被 claim 的候选允许由更新观察替换。`claim`/`release` 必须使用同一完整候选；`verifyPublication` 仅提升已 claim 且身份一致的 pending，已验证候选可幂等重放。相同 verified hash 返回 `no_change`，只清理未 claim 且不晚于当前观察的 pending。这里的 object key 是不带部署命名空间的逻辑 key；外部发布调用方负责选择 live/shadow 命名空间。

## 一次性同步与媒体生命周期

`runOnce` 通过端口注入依赖，按 lock → complete collection/calendar fetch → complete-state commit → media refresh → publication → backup → notification 顺序执行。每个阶段先更新 heartbeat；锁未取得时只记录并通知 `skipped`，不调用上游、媒体或发布写入。完整抓取失败不会提交 authority state；媒体的 detail、metadata 与 image 独立处理，瞬态失败保留最后成功引用并使本轮为 `partial`。只有明确的 detail `null` 才创建 24 小时 tombstone；detail 网络/服务端失败会清除已过期 tombstone 并在一小时后重试。图片 429、5xx 响应或 fetch 超时/网络错误也在一小时后重试；无效图片内容保留正常刷新调度。业务终态先写入 `sync_runs`，然后才投递通知；通知失败只更新独立的 `notification_failed` JSONB 摘要，不会把业务结果改成 `failed` 或撤销 publication/backup。下一轮会读取上一条已完成 run 的 compact `category/code/stage/attemptCount` 摘要。终态为 `success`、`no_change`、`skipped` 时进程退出码为 0，`partial` 与 `failed` 为非零。

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

live manifest 固定为 `public/manifest.json`，指向的 immutable snapshot 使用上面的逻辑 key；shadow manifest 固定为 `shadow/manifest.json`，shadow snapshot 实际写在 `shadow/<snapshot_key>` 下。共享 manifest parser 要求 `snapshot_key` 不含 namespace；读取 shadow manifest 的比较/验证调用方必须将其映射为 `shadow/<snapshot_key>` 后读取对象，不能把 shadow key 当作 live 对象，也不能把 shadow 发布到 live key。

Read Worker 直接读取 `public/manifest.json`，不再通过 KV `public:read-mode` 或 `public:current` 选择 live snapshot。它用共享 parser 校验 manifest 与 snapshot，并要求 generation、content hash、发布时间及 item count 一致；只有整份 `{ manifest, snapshot }` 通过校验后才用于公开响应。完整验证副本按 generation/hash 存入 Cache API，并由 `last-verified` pointer 发现；整对与 pointer 设置 30 天 freshness。只有当前请求能读取该 pointer 并重新验证其完整 envelope 时，才会依据 envelope 的 generation/hash 拒绝较低 generation 或同 generation 不同 hash 的 manifest，并使用该 envelope 回退。Cloudflare [Cache API 文档](https://developers.cloudflare.com/workers/runtime-apis/cache/)说明缓存内容不会复制到来源 data center 之外；缓存条目也可能缺失、过期或被逐出。写入队列只在单个 Worker isolate 串行，Cache API 不提供跨 isolate/POP 的共享原子 compare-and-swap，因此跨这些边界的回滚保护 best effort，不承诺全局 generation 单调。没有有效 Cache API 整对时才读取完整 legacy KV snapshot，不跨 R2、Cache API、KV 拼接字段。公开 URL、查询参数和响应形状保持不变；Read Worker 不访问 VPS 或 PostgreSQL。

live 发布先校验候选并读取 publication authority。hash 与 verified 相同则清理符合仓储规则的未 claim pending 并返回 `no_change`，不访问 R2。新 hash 使用 verified generation 的下一代；在任何 R2 操作前先持久化并 claim pending。随后读取并核对现有 live manifest 与 verified 状态，再严格按 snapshot 条件 PUT（`If-None-Match: *`）→ GET/规范化解析与 hash 校验 → manifest PUT → GET/字段校验 → `verifyPublication` 的顺序推进。immutable key 已存在时不覆盖；条件冲突只会继续读回，且字节、schema 与 hash 均匹配才可复用。已 claim 的同一 pending 重试复用原 generation 和已保存的 publication metadata；不同候选不能抢占它。shadow snapshot 使用同样的条件 PUT/readback 规则。

R2 失败时，已 claim pending 保持可重放，数据库 verified 不前移。manifest 写入尝试之前失败不会替换旧指针；manifest PUT 结果不确定或 readback 校验失败时，会尝试恢复旧 manifest 原始字节（首次发布则删除新指针）并再次读取确认。`verifyPublication` 抛错时，只有 fresh authority 确认仍是旧 verified 与同一 claimed pending 才恢复旧指针；状态未知时保留已验证候选并返回 pending。snapshot 可能作为未被 manifest 引用的 immutable 对象保留。shadow 使用自己的 manifest/snapshot namespace，不读写 live key，也不 claim 或 verify live publication。

如果进程未能确认回滚，下一次 live replay 会先比较当前 manifest 与 claimed pending。只有候选 manifest 的 schema/字段/字节以及 immutable snapshot 的 readback、schema 与 hash 均重新验证通过，才尝试提升 PostgreSQL verified。promotion 结果不明时，只有 fresh authority 明确仍为旧 verified 加同一 claimed pending 才恢复 prior；状态读取失败或返回其他状态时保留已完整验证的候选指针并返回 pending，等待下一轮 reconcile。候选验证失败时，从 verified snapshot 重建 canonical prior manifest 并读回确认（首次发布则删除候选指针），pending 保持可重放。

## PostgreSQL backup

本节记录已实现的 `createBackup` adapter 与 `apps/vps-sync/src/cli.ts` 注入式 composition。`createSyncEntrypoint`/`sync` 会从配置安装真实 Feishu notifier，调用方仍须提供其余同步端口和 backup 配置；不会安装 no-op notifier。coordinator 仅在 publication 为 `published` 或 `no_change` 时调用备份。备份失败会使该次 run 进入 `partial`，但不会撤销已完成的 publication。`sync` 入口接受 `--mode=shadow|live` 与 `--source=scheduled|manual`；webhook 配置由调用方从 `FEISHU_WEBHOOK_URL`（必填）、`FEISHU_WEBHOOK_TOKEN`、`FEISHU_WEBHOOK_SECRET` 和可选 `FEISHU_TIMEOUT_MS` 读取，URL/token/secret 不进入 argv 或日志。实际生产运行仍须由部署层提供完整的 PostgreSQL、上游、R2 与同步端口 composition；本任务不执行生产切换。

`pg_dump --format=custom --file=<private-temp-file>` 生成可由 `pg_restore` 恢复的 PostgreSQL custom archive。连接 URI 不传入子进程 argv 或日志；路径、query、用户名与密码按 libpq 规则解码 percent-encoding，query 中未编码的 `+` 保留为加号，query 的 `dbname` 覆盖 path 中的数据库名。实现将受支持的连接参数写入临时 `pg_service.conf`（0600），再通过 `PGSERVICEFILE` / `PGSERVICE` 选择该 service。子进程会清除继承的 libpq `PG*` 连接环境变量，避免宿主默认值覆盖或补充目标连接。service-file 和环境变量约定见 PostgreSQL [connection service file](https://www.postgresql.org/docs/17/libpq-pgservice.html) 与 [environment variables](https://www.postgresql.org/docs/17/libpq-envars.html)。实现先流式读取 archive 计算 SHA-256 与字节数，再以带 `ContentLength` 的流式 R2 PUT 写入 dump，成功后才写 manifest。上传使用单次 PutObject 而非 multipart；Cloudflare R2 单次 PutObject 上限为 5 GiB，接近该上限时应先实现 multipart 再提升该边界（见 [R2 upload limits](https://developers.cloudflare.com/r2/objects/upload-objects/)）。

临时根目录 `/tmp/airing-cal` 不存在时会以 `0700` 创建；已存在时必须为当前用户所有、非符号链接且无组/其他用户权限，否则 backup 会 fail closed。其下的 `/backup-*` 目录限制为 owner-only，并在成功或失败后清理。PostgreSQL 17 custom archive 与连接参数语义见官方文档：[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)、[libpq connection URIs](https://www.postgresql.org/docs/17/libpq-connect.html)、[libpq environment variables](https://www.postgresql.org/docs/17/libpq-envars.html)。

Dump 和 manifest 使用同一 UTC 时间戳与完整 git SHA：

```text
backups/postgres/YYYY/MM/DD/YYYYMMDDTHHmmssSSSZ-<git-sha>.dump
backups/postgres/YYYY/MM/DD/YYYYMMDDTHHmmssSSSZ-<git-sha>.json
```

manifest 是规范化 JSON，固定字段为 `schema_version`、`run_id`、`git_sha`、`created_at`、`object_key`、`size` 与 `sha256`。Dump 必须先成功上传，manifest 才可见；命令、dump 上传或 manifest 上传失败均记为 backup 失败；只有当调用方通过 `runOnce` backup port 执行该 adapter 时，coordinator 才会据此将 run 终态标为 `partial`。

### Retention 与 restore verification

`selectBackupDeletions` 是纯函数，只接收一次完整的 backup key 列表并返回待审查的成对 dump/manifest key：最近 30 个有完整 restore point 的 UTC 日期各保留最后一点，更早日期按每个日历月保留最后一点。`null`、列表不确定、非法或不成对 key 均返回空列表。本任务不会调用 R2 Delete；历史对象的实际删除需要另行批准的 OpenSpec change。

`restoreVerify` 只提供注入式恢复校验流程：调用方注入备份 key、target URL 函数、S3 `get` 与数据库会话。流程先校验 key grammar、dump/manifest canonical bytes 与 SHA-256，再用同一 target session 的 `withSessionLock` 回调覆盖“空库检查 → `pg_restore` → 恢复校验”；锁不可取得时回调不会执行，因而不会启动 `pg_restore`。恢复目标遵循 PG17 libpq 的单 endpoint 语义：`host`、`hostaddr` 或 `port` 的逗号列表一律 fail closed；存在 `hostaddr` 时以它作为有效网络 endpoint，与端口和数据库名组成 production identity，避免通过不同 `host` 或凭据绕过生产库门禁。该有效 endpoint 必须不等于 production identity，命令使用 `pg_restore --dbname=service=<private-service> --no-owner --no-privileges --single-transaction`。该锁边界只约束遵守同一 advisory-session-lock 协议的写者；不遵守协议的外部连接或超级用户写入不在此保证内，调用方仍须提供隔离的 disposable target。注入的 expected 与恢复后实际 migrations 都必须是非空的严格 `{name, checksum}` 列表，checksum 必须是 64 位小写 SHA-256；空列表、字符串条目和空/畸形 checksum 均 fail closed。恢复后校验 migration checksums、核心表行数、`publications.verified` 与 immutable baseline snapshot 的 key/hash/canonical bytes；baseline 只提供 PostgreSQL 未保存的 weekday labels 及历史数组顺序/身份索引，collection、calendar、summary 和 item 值全部从恢复数据库投影重建。任何 baseline 缺失、身份集合不匹配或 hash 不一致都会 fail closed。该流程本身不 publish、不发送通知；下方 process-facing wrapper 只接收 backup key 与目标环境变量名，仍需注入 runtime ports。

### Shadow / restore / cutover / rollback 证据

每次人工演练把以下最小 JSON 证据保存到变更记录；token、数据库 URL、R2
credential 和原始异常不得写入证据：

```json
{
  "operation": "shadow-compare",
  "status": "executed",
  "mode": "shadow",
  "run_ids": ["<run-id-1>", "<run-id-2>", "<run-id-3>"],
  "field_diff_count": 0,
  "manifest_key": "shadow/manifest.json",
  "restore_key": "<backup-key>",
  "dry_run": false
}
```

Build 阶段只在 fake ports 上运行三轮 shadow compare 和一次 restore dry-run：

```sh
node --import tsx/esm --test apps/vps-sync/src/operations/migration.test.ts
node --import tsx/esm apps/vps-sync/src/cli.ts shadow-compare --help
node --import tsx/esm apps/vps-sync/src/cli.ts restore-verify --help
node --import tsx/esm apps/vps-sync/src/cli.ts cutover --help
node --import tsx/esm apps/vps-sync/src/cli.ts rollback --help
```

真实生产三次 shadow、一次 restore drill、七日观察和 cutover 属于 Archive
之后的人工 rollout gate；Build 不读取生产 manifest、scheduler 或数据库，也不执行
rollback。rollback 只能提交由 manifest/snapshot readback 重新验证的 envelope，并且
只恢复 `public/manifest.json`，不反向 migration、不删除 PostgreSQL 行或 R2 对象。

## 上游完整抓取与重试

VPS 适配器使用 `maxGetRetries: 0` 构造 `BgmClient`，每个 collection 分页请求和 calendar 请求只由外层 retry 处理，最多三次尝试。所有配置用户的分页和 calendar 通过完整性校验后，才会生成可提交的 `CompleteFullFetch`；primary user、任一分页或 calendar 不完整都会 fail closed。

| 上游结果 | 处理 |
| --- | --- |
| 401 / 403 | 认证终态，一次失败，不重试。 |
| collection / calendar 404 | `not_found` 终态，不当作空数据。 |
| 429、5xx、超时、网络错误 | 最多三次外层尝试；`BgmClient` 仅透传响应的 `Retry-After` header 值，合法值受最大延迟限制，否则使用有界指数退避和 jitter。 |
| invalid JSON、schema mismatch、分页漂移或重复项 | `contract` 终态，不返回完整输入。 |

持久化/通知只使用稳定的 `category`、`code`、`stage` 和 `attempt`，不携带 token、URL、响应 body 或底层异常消息。

## 飞书通知 payload 与签名

Task 6.1 的 `buildFeishuMessage` 只构造文本消息，不读取 webhook；Task 6.2 的 `deliverNotification` 负责单次真实 POST，不自动 retry。每个终态（`success`、`no_change`、`partial`、`failed`、`skipped`）都包含 run ID、mode/source、Asia/Shanghai 时间、publication generation/hash、计数、阶段耗时、publication/backup/notification 结果，以及 Node/Alpine 字段。`runOnce` 将依赖注入的 `gitSha` 传入 sanitized `RunResult`，消息边界只输出严格 40 位小写 SHA，否则为 `unknown`；Alpine 明确为 `unknown`，Node 使用 `process.version`。只消费结构化、已脱敏的 `RunResult`。

飞书官方契约参考：[自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)（官方页面最后更新 2025-03-27；本次访问 2026-09-17）。已核验结论：请求为 HTTP POST JSON，基础 body 使用 `msg_type` 和 `content`；签名开启时再加入字符串秒级 `timestamp` 与 `sign`。`timestamp` 必须距当前不超过 1 小时（3600 秒），`sign` 为以 `timestamp + "\\n" + secret` 为 HMAC-SHA256 key、对空字符串计算后再 Base64 编码。成功响应的 `code` 为 `0`（`StatusCode`/`StatusMessage` 是兼容旧逻辑字段，不作为判断依据）；请求体上限为 20 KB。

`signFeishu(timestamp, secret)` 实现上述纯签名计算；`deliverNotification` 使用注入的 `fetch`/clock，设置有界 timeout 和 `AbortController`，只发送一次，非 2xx、无效 JSON、`code !== 0` 或超时均返回 `failed`，官方成功语义只接受 `code === 0`。请求体限制为 20 KiB。Webhook URL、token、header、secret、数据库/R2 credential 及 raw exception 不进入 payload、日志或 `notification_failed`；失败只持久化稳定的 `category=notification`、失败 code、`stage=notification` 与 `attemptCount`。

## Secret 禁存与测试

数据库只保存明确列出的业务字段；额外 upstream 属性、raw response、authorization、token、webhook 和连接配置不写入 JSON。初始化 authority 时必须传入运行时凭据值列表，所有可持久化自由文本/JSON 都会检查这些值；发现匹配即在写入前拒绝。通用 PostgreSQL URL、Bearer header、带密码 URL 也会被拒绝。错误持久化只接受稳定类别，未知错误映射为 `UNKNOWN`，不会存异常消息。`finishRun` 通过固定字段记录终态、组件结果、媒体计数与阶段耗时；通知结果可更新，但不能改写已结束 run 的业务状态、publication 或 backup 结果。

仓储测试沿用 `VPS_SYNC_TEST_DATABASE=1` 与 disposable `DATABASE_URL`。运行包测试会同时覆盖 migration 与 repository；CI 的 PostgreSQL 17 service 已启用上述变量。数据库断言包括完整 rollback、两次缺失/恢复、媒体 fence、publication pending/replay/claim/generation 冲突，以及遍历测试 schema 所有 text/json 列的 secret 扫描。缺少本地数据库时这些断言明确标记 skipped，不能以单元测试通过替代。
