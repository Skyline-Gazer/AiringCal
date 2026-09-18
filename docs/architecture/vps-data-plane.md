# VPS data plane architecture

## 范围与当前阶段

VPS 数据平面由宿主机 cron 手工运行一个短生命周期的 Compose `sync`
service。它负责 PostgreSQL authority、媒体刷新、R2 snapshot publication、
PostgreSQL backup 和飞书终态通知；Read Worker 仍是公开读取边界。当前 Build
阶段只交付可审计的镜像、Compose 包装、注入式运行时和文档，不代表已经执行
生产 shadow、restore drill 或 cutover。

`deploy/vps/run-sync.sh` 不发布镜像、不部署 VPS、不切换公开 manifest，也不
自动清理旧 Cloudflare 资源。live 运行仍需要单独的人工批准和后续迁移门禁。

## 运行链路

```text
host cron / manual
  -> run-sync.sh (non-blocking flock)
  -> Docker Compose service sync (full SHA image, node, read-only root)
  -> apps/vps-sync/src/cli.ts: sync
  -> PostgreSQL advisory lock and run state
  -> Bangumi complete fetch -> authority transaction -> media -> R2 publication
  -> PostgreSQL backup -> Feishu notification
```

Compose 的真实输入来自 `deploy/vps/compose.yaml`，包含 PostgreSQL、Bangumi、
R2 和 Feishu 配置。镜像引用必须是
`ghcr.io/skyline-gazer/airing-cal-sync:<40 lowercase hex SHA>`；`latest`、短 SHA
和 `-debug` tag 不能用于生产 Compose。生产镜像以 `node` 用户运行；debug 镜像
只供人工排障。

## 可执行入口与注入式 API

| 名称 | 当前真实接口 | 可执行状态 |
| --- | --- | --- |
| `sync` | `main()` / `sync()`；接受 `--mode=shadow\|live` 与 `--source=scheduled\|manual` | 有 process-facing 入口，但必须由部署层注入完整 runtime；缺少注入依赖时 fail closed |
| `migrate` | `applyMigrations(pool)`，按文件名顺序执行并校验 checksum | 仅 TypeScript API；当前没有 `migrate` CLI |
| `backup` | `createBackup(deps, run)`，生成 dump 与 manifest 并上传 R2 | 仅 TypeScript API；当前没有 `backup` CLI |
| `restore-verify` | `restoreVerify(deps, key, targetUrl)`，恢复到注入的 disposable target 并校验 | 仅 TypeScript API；当前没有 `restore-verify` CLI，凭据与命令包装留 Task 9.3 |
| retention | `selectBackupDeletions(entries)`，只返回成对候选 key | 纯函数，不发送 R2 Delete |

因此文档不把 `migrate`、`backup` 或 `restore-verify` 写成已经上线的操作
命令。`sync` 的 help contract 是：

```text
Usage: sync [--mode=shadow|live] [--source=scheduled|manual]
```

## 环境变量

下表逐项来自 Compose；`.env.example` 是占位模板，实际 secret 只放在 VPS
私有 `.env` 中并设置 `chmod 600`，不进入 argv、日志、R2 manifest、backup 或
Feishu payload。

| 变量 | 必填 | 用途 |
| --- | --- | --- |
| `VPS_SYNC_IMAGE` | 是 | 现有的完整 git-SHA production image |
| `DATABASE_URL` | 是 | PostgreSQL connection URI；仅当前进程使用 |
| `BANGUMI_TOKEN` | 是 | bgm.tv access token |
| `BANGUMI_USERS` | 是 | 逗号分隔的同步用户名 |
| `R2_ENDPOINT` | 是 | Cloudflare R2 S3-compatible endpoint |
| `R2_BUCKET` | 是 | data/public 与 backup 使用的 bucket |
| `R2_ACCESS_KEY_ID` | 是 | R2 least-privilege access key |
| `R2_SECRET_ACCESS_KEY` | 是 | R2 secret key |
| `FEISHU_WEBHOOK_URL` | 是 | Feishu custom-bot HTTPS webhook |
| `FEISHU_WEBHOOK_TOKEN` | 否 | Feishu query token |
| `FEISHU_WEBHOOK_SECRET` | 否 | Feishu HMAC signing secret |
| `FEISHU_TIMEOUT_MS` | 否 | bounded notification timeout，默认 `10000`，最大 `60000` |

`FEISHU_WEBHOOK_URL`、token、secret 和 timeout 由 `feishuConfigFromEnv` 读取；
其余同步端口由部署 adapter 注入。当前仓库没有把完整 PostgreSQL/BGM/R2
composition 硬编码进 CLI。

## PostgreSQL schema 与迁移

`applyMigrations(pool)` 使用 advisory session lock，创建不可变的
`schema_migrations`，按文件名顺序运行下列 SQL，并拒绝 checksum mismatch、
schema ahead 或 migration gap；没有 destructive rollback：

| migration | 真实变更 |
| --- | --- |
| `0001_initial.sql` | `schema_migrations`、`users`、`sync_runs`、`subjects`、`collection_items`、`subject_media`、`calendar_entries`、`publications` |
| `0002_media_component_state.sql` | `subject_media.component_state` JSONB |
| `0003_notification_failed.sql` | `sync_runs.notification_failed` JSONB |

`sync_runs` 的状态是 `running`、`success`、`no_change`、`partial`、`failed` 或
`skipped`；`publication`、`backup` 和 `notification` 各自保留
`not_attempted`、`success`/对应成功值或 `failed`。备份属于 publication 之后
的阶段，失败只把 run 变为 `partial`，不撤销已经验证的 publication。

## R2 对象与公开读取

| 逻辑用途 | key |
| --- | --- |
| live manifest | `public/manifest.json` |
| shadow manifest | `shadow/manifest.json` |
| immutable public snapshot | `snapshots/v1/<generation>-<content_hash>.json` |
| shadow snapshot | `shadow/<snapshot_key>` |
| image object | `images/<hash>/original`；shadow media 使用 `shadow/images/<hash>/original` |
| PostgreSQL dump | `backups/postgres/YYYY/MM/DD/YYYYMMDDTHHmmssSSSZ-<git-sha>.dump` |
| backup manifest | 同一时间戳与 SHA 的 `.json` key |

`PublicSnapshotManifestV1` 的固定字段是 `schema_version`、`generation`、
`snapshot_key`、`content_sha256`、`published_at`、`source_observed_at`、
`item_count` 和 `git_sha`。live publication 先写 immutable snapshot 并回读
校验，再更新 `public/manifest.json`；shadow 只写 shadow namespace，不切换 live
manifest。Read Worker 读取并验证完整 manifest/snapshot pair，失败时回退到
last-verified Cache API pair，再回退完整 legacy KV snapshot，不跨来源拼接字段。

## Read Worker 路由与事件

Read Worker 内部路径由 `apps/read-worker/src/index.ts` 实现：

| Read Worker route | 公开映射 |
| --- | --- |
| `/collections` | `/api/collections` |
| `/calendar` | `/api/calendar` |
| `/config` | `/api/config` |
| `/health` | `/api/health` |
| `/cache` | `/api/cache` |
| `/image/` | `/image/` |

同步操作通过 `/api/sync/compare`、`/api/sync/apply` 和 `/api/check/:id` 进入
旧 Cloudflare sync Worker；其 operation log 的事件值是 `sync_operation`。VPS
Feishu delivery 的 logger 只记录结构化 `notification_failed` 和 reason，不
记录 webhook、credential 或 raw response。Read Worker 本身没有额外的
`console` event contract；健康响应公开 `snapshot`、`migration`、`budget` 和
`data.workflow` 字段，不能据此推算真实写入量。

## 发布、回退与旧 change 边界

`.github/workflows/vps-sync-image.yml` 只在通过 typecheck/test/build check 后
构建并发布 GHCR image；push 使用完整 SHA，manual `workflow_dispatch` 的
`debug=true` 只发布 `<full-git-sha>-debug`。它不读取 VPS/database/R2/Bangumi/
Feishu secrets，不 SSH，不运行 Compose，也不触发同步。

以下旧 Cloudflare changes 已 frozen/superseded：

- `harden-workflow-request-budget`
- `adopt-d1-r2-incremental-sync`
- `migrate-public-reads-from-kv`

它们仍可作为现有 Read Worker/快照兼容行为的实现证据，但不应被描述为 VPS
自动调度、自动部署或已完成生产切流。旧资源清理、删除和 30 日 retention
属于未授权的后续 change；当前没有自动清理。

回退只选择已验证的上一完整 SHA image，按人工 runbook 停止/恢复调度并保留
PostgreSQL、R2、KV、Queue、Workflow 和 Durable Object 数据；不得 reverse 已应用
migration、删除 backup 或覆盖历史 immutable object。生产切换和 rollback 的真实
控制面操作留给显式批准的后续 gate。
