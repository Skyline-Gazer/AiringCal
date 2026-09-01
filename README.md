# AiringCal

> 在静态页面中渲染你的 Bangumi 追番进度。

AiringCal 是一个 Cloudflare Workers monorepo。它把公开访问、只读数据、定时同步、媒体补全拆成 4 个独立 Worker，让公开页面、legacy KV 读取、D1/data R2 shadow 同步、bgm.tv 抓取和图片下载分别使用自己的 Worker 调用预算。

## 架构

部署后会有 4 个独立 Worker：

| Worker | 目录 | 职责 |
|--------|------|------|
| `airing-cal-frontend` | `apps/frontend-worker` | 唯一公开入口，提供页面、widget 静态资源、BFF JSON route 和 `/image/:hash` 代理 |
| `airing-cal-read` | `apps/read-worker` | 内部只读 API；公开响应按 `public:read-mode` 从 legacy KV snapshot/状态或验证过的 R2 `PublicSnapshotV1` 读取（迁移期默认 legacy，切换后 R2，带 Cache API 最后验证版与 legacy KV 双层 fallback）；`/api/health` 暴露 generation/source/budget/migration 摘要 |
| `airing-cal-sync` | `apps/sync-worker` | Cloudflare Workflow 编排 collection/calendar；每日 20:00 UTC cron 的 live 发布后追加 D1 shadow 阶段：增量同步、legacy 导入、shadow 等价比较、KV 预算记录、门禁通过后提升 shadow pointer 并切换 read-mode、14 天后限速清理 legacy key |
| `airing-cal-media` | `apps/media-worker` | Queue consumer；D1-only V4 任务以 D1 保存媒体权威状态并写 image R2，live V3 与 V2/legacy 任务保留 KV 兼容路径 |

共享 package：

| Package | 职责 |
|---------|------|
| `@airing-cal/bgm-api` | bgm.tv client、OpenAPI 对齐的类型、API helpers |
| `@airing-cal/domain` | snapshot merge、image ref、subject meta、queue/data contracts |
| `@airing-cal/storage` | KV/D1/R2 adapter、迁移、typed state contract 和 key builder |
| `@airing-cal/widget` | HTML shell、footer runtime status、widget JS/CSS assets |
| `@airing-cal/worker-common` | public error、安全 header、敏感信息清理、部署/文档守护测试 |
| `@airing-cal/vps-sync` | VPS Node 同步 coordinator、PostgreSQL 与上游适配器 |

Widget 资产的唯一手写源是 `packages/widget/assets/theme/{bangumi.js,bangumi.css,cache.js}`，唯一运行时生成产物是 `packages/widget/src/generated-assets.ts`。修改主题源后运行：

```bash
pnpm -F @airing-cal/widget generate
```

生成链测试会拒绝生成产物漂移，也会拒绝重新引入 `assets/public` 或 `assets/theme/v1` 副本。

## VPS sync 可选 Sentry tracing

`@airing-cal/vps-sync` 的 Node tracing adapter 只供 VPS 同步 coordinator 使用；Cloudflare Workers 不读取这些变量，也不依赖 `@sentry/node`。

| 变量 | 已实现行为 |
|------|------------|
| `SENTRY_DSN` | 未设置时不初始化 Sentry，也不发送 tracing；设置后启用 VPS adapter。 |
| `SENTRY_TRACES_SAMPLE_RATE` | 可选的有限 `[0, 1]` 数值；未设置默认 `1`，无效值会禁用 adapter。 |

adapter 仅创建手工 root/stage spans，属性只包含 mode、source、stage、终态、有限计数、耗时和 git SHA。它禁用默认自动 integrations 和 PII；不会记录原始异常、URL、request/response body、用户名、subject/数据库标识或 credential。初始化、span 和最多 2 秒的 flush 失败均 fail-open，不改变同步、持久化、通知或退出码。

## 外部访问入口

外部只访问 `airing-cal-frontend`。如果使用 workers.dev，地址通常是：

```text
https://airing-cal-frontend.<你的 workers.dev 子域>.workers.dev
```

如果绑定自定义域，也绑定到 `airing-cal-frontend`，不要绑定到 read/sync/media Worker。

公开 route：

| Route | 说明 |
|-------|------|
| `/` | 公开 widget 页面，带共享 footer 和 build link |
| `/src/bangumi.js` | Widget script |
| `/src/bangumi.css` | Widget styles |
| `/src/cache.js` | Footer runtime status script |
| `/api/collections?type=watching&page=1&limit=24` | 通过 `READ_WORKER` 分页读取 collection snapshot；`type` 必须是五种已发布类型之一，`limit` 最大 100 |
| `/api/calendar` | 通过 `READ_WORKER` 读取 calendar snapshot |
| `/api/config?key=nsfw` | 通过 `READ_WORKER` 读取公开配置 |
| `/api/health` | 通过 `READ_WORKER` 读取健康状态、轻量 cache 摘要、cron 兼容状态和最近 Workflow run |
| `/api/cache?limit=100&cursor=<opaque>` | 通过 `READ_WORKER` 分页读取脱敏缓存 JSON；`limit` 最大 100，当前页数量字段为 `page_subjects` |
| `/api/sync/compare` | 通过 `SYNC_WORKER` 执行动画收藏对比 |
| `/api/sync/apply` | 通过 `SYNC_WORKER` 执行动画收藏同步并写操作日志 |
| `/api/check/:id` | 通过 `SYNC_WORKER` 查询 24 小时内的同步操作日志 |
| `/image/:hash` | 通过 `READ_WORKER` 读取 R2 图片 |

账号 compare 返回的差异条目包含规范化 `itemA` / `itemB`。页面按方向选择源 item，并以最多 5 条一批提交给 `/api/sync/apply`；apply 直接复用这些 items，不会为每批重新拉取全部源收藏。旧 `subject_ids` 输入暂时兼容一个版本且同样限制为 5 条。用户 token 只存在于当前请求内，不写入 KV operation log、Queue 或其他异步载荷；compare、apply 和 check 响应统一使用 `Cache-Control: no-store`。

compare 会先认证两个账户；身份或收藏请求中任一账户返回 401/403 时，compare 都会停止且不会返回部分或空成功，并以相同 HTTP 状态返回稳定的 `AUTHENTICATION_FAILED` 错误 code。错误响应不会包含账户 token；限流、网络或其他 bgm.tv 上游故障仍使用 `REQUEST_FAILED` 或既有的部分结果语义。

apply 同步章节进度时，会以 `limit=1000`、递增 offset 读取源/目标账户的全部章节收藏，再按目标章节状态分组并以每批最多 100 个 episode ID PATCH。某一批失败时，该条目返回 `status: "error"`、`code: "EPISODE_PATCH_PARTIAL"`、已经成功更新的 `succeeded` 数量和失败批次 `failedBatch`；此前成功批次不会被描述成整体成功。

`airing-cal-sync` 没有公开同步 URL。Cloudflare Workflows Free Plan 不支持原生 Workflow schedule，因此生产定时入口是同一个 sync Worker 的轻量 Cron；Cron 每天 04:00 Asia/Shanghai（前一 UTC 日 20:00）只创建一个 live Workflow instance，不拉取 bgm.tv、不读写业务缓存。Cloudflare Cron 按 UTC 执行，所以 checked-in 表达式是：

```toml
[[workflows]]
name = "airing-cal-sync"
binding = "SYNC_WORKFLOW"
class_name = "SyncWorkflow"

[triggers]
crons = ["0 20 * * *"]
```

旧的业务同步 Cron 实现与同步 trigger queue 已移除；当前 Cron 只调用 `SYNC_WORKFLOW.create()`。部署不会自动创建业务 instance；只有 Worker Cron 或明确的手动 control-plane 操作会触发同步。手动 shadow 会写隔离快照和审计结果，不覆盖正式 snapshot；shadow 不预留预算且不投递 Media Queue：

```bash
pnpm exec wrangler workflows trigger airing-cal-sync '{"mode":"shadow","source":"manual"}' --id shadow-<commit> --config apps/sync-worker/wrangler.toml
pnpm exec wrangler workflows instances describe airing-cal-sync shadow-<commit> --config apps/sync-worker/wrangler.toml
```

本机没有 Cloudflare API token 时，使用 GitHub Actions 中保存的部署 secret 手动触发，不需要把 token 下载到开发机：

```bash
gh workflow run sync-workflow.yml --ref dev -f operation=trigger -f mode=shadow -f instance_id=shadow-<commit> -f ref=dev
gh run watch <run-id> --exit-status
```

`Manual Sync Workflow` 支持 `trigger`、`describe`、`restart`、`terminate` 四种日常控制面操作；trigger 的 mode 只能显式选择 `shadow` 或 `live`。它不会部署代码；定时 live instance 由 Worker Cron 创建。

从旧 Queue 架构首次切换时，如果 Cloudflare 仍保留历史 consumer 关联，使用一次性 `cleanup-legacy-consumer` 操作解除关联后再部署；它不会删除 Queue 数据或 Media Queue。

instance 运维命令形态：

```bash
pnpm exec wrangler workflows instances restart airing-cal-sync <instance-id> --config apps/sync-worker/wrangler.toml
pnpm exec wrangler workflows instances terminate airing-cal-sync <instance-id> --config apps/sync-worker/wrangler.toml
```

Workflow 每个 collections 页、calendar、发布类型和 refresh chunk 都使用确定性 step 名；大 payload 写 staging KV，step 只返回 key、数量和 SHA-256 摘要。live initialize 通过 `SNAPSHOT_COORDINATOR` 分配单调 generation 并立即写 `sync:current`；refresh planning 每 10 个 subject 有界读取现有 detail、metadata、image 与 refresh 状态，只为缺失、源变化、重试到期或确定性刷新时间已到的组件生成幂等 V3 候选。候选按 new/changed、hot due、cold shard、retry 排序；普通任务受 soft limit 50 限制，只有 new/changed 可扩展到 hard limit 100。cold 候选按 `subject_id mod 7` 分散到 7 个 UTC 日。

scheduled live 与 manual live 共享同一个 UTC 自然日预算，没有强制绕过 hard limit 的参数。`SNAPSHOT_COORDINATOR` 先以稳定 reservation 预留逻辑预算，再最多调用一次 Queue producer；Queue 确认结果不确定时按 fail-closed 保留预算并标记 uncertain，不重发同一 reservation，但仍提交 collection/calendar snapshot。未变化 subject 不产生逐 subject KV 写入，也不投递媒体任务。Workflow 只读逐 subject 媒体状态，实际 detail/meta/image/refresh 写入仍由 Media Worker 执行。401/403 立即终止，429、5xx、timeout 和网络错误由网络 step 最多重试 3 次。部署顺序固定为资源 resolve/Cron preflight → D1 migration → read/media → sync + Workflow → `workflows describe` → frontend，部署完成仍不会自动创建业务 instance。

收藏页不会在每次浏览页面时实时请求 bgm.tv。Workflow 以 `limit=50` 获取 collections 并按 bgm.tv `type` 发布 `want`、`watched`、`watching`、`on_hold`、`dropped` 版本化快照；读取端跟随 `snapshot:active` 读取同一个 instance 的五类 collections、calendar 和 summary，并在返回数据前验证 manifest 恰好列出这 7 个 required key 及其 SHA-256 digest。带有任一 V3 字段（`generation`、`required_keys`、`digests`）的 active manifest、key 或 digest 不完整时返回 HTTP 503 `SNAPSHOT_INCOMPLETE`，绝不逐 key 混入 legacy 数据；active 完全不存在，或旧 active pointer 同时不含上述三个 V3 字段时，才整套读取 legacy snapshot。Workflow 不请求 subject detail；detail、metadata 和图片由 Media Queue 以 stale-while-revalidate 方式异步收敛。

collections 使用 bgm.tv OpenAPI 允许的 `limit=50` 分页，并受 120 秒整体预算约束。bgm.tv JSON GET 请求单次 timeout 为 10 秒；429、5xx、timeout 和网络错误最多重试 2 次，401/403 不重试，POST/PATCH 写请求也不会被 client 隐式重试。

`/api/health` 仍保留 `data.cron.last` 作为迁移兼容字段，`data.cron.next_at` 按每日 20:00 UTC 计算；最近 instance 优先来自 initialize 阶段写入的 `sync:current`，因此 running 或硬中断实例不必等待 finalize 才可见。最近 instance 来自 schedule 时，cron 字段由对应 Workflow run 的同一个 effective status 派生，不再返回旧 Queue 遗留状态或出现 `stale/running` 分裂。`data.collections.updated_at` 优先使用当前 active snapshot 的发布时间。公开 health 响应内的现行应用状态字段仍是 `data.workflow`，Cloudflare Workflow 控制面状态是最终依据。

`/api/health` 的 `data.workflow` 暴露最近 instance 的 `instance_id`、mode、source、stage、heartbeat、完成时间、计数和脱敏错误。聚合计数包含 eligible candidates `refresh_candidates` 及 `refresh_candidates_by_priority`、planner 选中 `refresh_selected`、逻辑获批 `refresh_granted`、预算留待后续 `refresh_deferred`（等于 `refresh_candidates - refresh_granted`）、producer 已确认/不确定的 `refresh_confirmed` / `refresh_uncertain`，以及预留前跳过的 `refresh_skipped`（等于 `subject_count - refresh_candidates`）。`refresh_jobs` 是 `refresh_granted` 的兼容 alias，只表示逻辑预算获批，不表示 Queue 一定物理接收；异步 consumer 的真实 KV PUT 只能从 consumer 与 Cloudflare 指标观察，Workflow 不推算实际写入数。成功或失败 run 都保留已到达的最新聚合值；这些字段只写入已有 run 记录，不创建逐 subject 指标 key。`queued`、`running` 或 `retrying` run 超过 20 分钟没有 heartbeat 时，应用侧返回 `status: "stale"` 与 `stale: true`；实际恢复、重启或终止仍以 Cloudflare Workflow instance 控制面状态为准。

`/api/health` 在保留上述 legacy 字段的同时新增：`snapshot`（source/legacy 或 r2、generation、r2_key、verified_at）、`migration`（shadow_streak、legacy 导入游标与计数、kv_budget_ok、read_mode）与 `budget`（media reserved/consumed/soft/hard）。D1 读取失败时这些字段返回零值并置 `degraded: true`，不破坏既有契约。D1 rows、data R2 对象、Queue 和 KV pointer 的实际用量及错误必须分别在 Cloudflare Workflow/D1/R2/Queue/KV 控制面核对，不能从公开 health 推算。

Worker Cron 来自 checked-in `wrangler.toml`；routine deploy 只同步代码与配置，不主动触发 live instance。

### D1 / data R2 shadow 边界

D1/data R2 实现运行在 manual `shadow` Workflow 与每日 20:00 UTC 调度 Workflow 的 shadow 阶段：

1. 完整获取所有用户的 collections 与 calendar，只有完整边界通过才计算 D1 diff。
2. D1 以 `collection_items`、`subject_media`、`sync_runs`、`sync_budget`、`app_state` 五张主表保存新权威状态；`sync_budget_reservations` 是稳定 reservation 的幂等 helper table。
3. 新公开契约先写入 `airing-cal-data` 的不可变对象 `snapshots/v1/{generation}-{content_hash}.json`，回读并验证 schema、generation、hash、key 与完整 bytes。
4. 迁移期 shadow 发布把 pointer 写入 `public:shadow-current`；只有连续 7 次每日 shadow 一致且 KV 写预算达标后，才把 shadow pointer 提升为 `public:current` 并置 `public:read-mode=r2`。pointer 只包含 `schema_version`、`generation`、`content_hash`、`r2_key` 和 `published_at`；相同已验证内容不写 R2、不增加 generation、也不写 pointer。
5. D1/R2/pointer 任一步失败都保留 pending/分类错误供同一 instance replay；不会通过回滚 D1 行或覆盖另一个 R2 generation 来“恢复”。

公开读取入口由 `public:read-mode` 决定：`legacy` 时跟随 legacy KV `snapshot:active`/versioned keys（图片继续来自 `AIRING_CAL_R2`）；`r2` 时验证 `public:current` 后读取 `airing-cal-data` 的 `PublicSnapshotV1`，并用 Cache API 最后验证版与 legacy KV 双层 fallback。legacy 逐 subject 导入、shadow 门禁、`public:current` 读切换与旧 KV 限速清理由 OpenSpec change `migrate-public-reads-from-kv` 实现；切换与回滚操作见 [docs/runbook/migrate-public-reads.md](docs/runbook/migrate-public-reads.md)。

media soft limit 50、hard limit 100 的 D1 reservation contract 已实现；只有 `new_or_changed` 候选可使用 privileged headroom。当前 shadow 调用不传 Queue submitter，因此 D1 路径 grant/submit 为 0；scheduled/manual live 仍使用 `SNAPSHOT_COORDINATOR` 的兼容预算和 legacy snapshot 发布。

## Cloudflare 资源

当前约定的 Cloudflare 资源名：

| 类型 | 名称 |
|------|------|
| D1 database | `airing-cal-state` |
| R2 data bucket | `airing-cal-data` |
| KV namespace title | `airing-cal-kv` |
| R2 image bucket | `airing-cal-images` |
| Queue | `airing-cal-media` |
| Service binding | `READ_WORKER -> airing-cal-read` |
| Service binding | `SYNC_WORKER -> airing-cal-sync` |

当前绑定名：

| Worker | Binding |
|--------|---------|
| `airing-cal-frontend` | `READ_WORKER`, `SYNC_WORKER` |
| `airing-cal-read` | `AIRING_CAL_D1`, `AIRING_CAL_KV`, `AIRING_CAL_R2`, `AIRING_CAL_DATA_R2` |
| `airing-cal-sync` | `AIRING_CAL_D1`, `AIRING_CAL_KV`, `AIRING_CAL_DATA_R2`, `MEDIA_QUEUE`, `SYNC_WORKFLOW`, `SNAPSHOT_COORDINATOR` |
| `airing-cal-media` | `AIRING_CAL_D1`, `AIRING_CAL_KV`, `AIRING_CAL_R2`, `SUBJECT_REFRESH_COORDINATOR` |

Cloudflare 资源创建已经与常规部署分离。首次部署或资源缺失时，在 GitHub Actions 中手动运行 `Bootstrap Cloudflare Resources`（手动 bootstrap workflow）：

- 创建或复用 KV namespace `airing-cal-kv`，并把实际 namespace ID 注入后续 Worker deploy config。
- 创建或复用 D1 database `airing-cal-state`，并记录其 Cloudflare UUID。
- 创建或复用 R2 data bucket `airing-cal-data`。
- 创建或复用 R2 bucket `airing-cal-images`。
- 创建或复用 Queue `airing-cal-media`。
- 后续 Wrangler deploy 会按 checked-in 配置确认 `airing-cal-frontend` 的 service bindings 指向 `airing-cal-read` 和 `airing-cal-sync`。

KV 与 D1 的 checked-in config 都保留可审计占位符；deploy resolver 输出真实 ID，materializer 校验格式后只写到 runner 临时 config。KV 的 `kv_namespaces.id` 不是 namespace title，而是 Cloudflare 生成的 32 位十六进制 namespace ID；D1 的 `database_id` 是规范 UUID：

```toml
id = "<AIRING_CAL_KV_NAMESPACE_ID>"
database_id = "<AIRING_CAL_D1_DATABASE_ID>"
```

对应的 materialization 环境名是 `AIRING_CAL_KV_NAMESPACE_ID` 与 `AIRING_CAL_D1_DATABASE_ID`；它们是 resolver job output 的进程内传递名，不是需要手工新增的 Worker secret。

常规 deploy 只读解析实际 KV namespace ID 与 D1 database ID，同时验证 D1、两个 R2 bucket、KV 与 Queue；资源不存在时会明确失败并提示先运行 bootstrap，不会在发布途中创建资源。bootstrap 会准备或复用全部五类资源，随后使用同一生产凭证运行只读 resolver，确认全部资源可解析后才报告 D1/KV ID。read/sync/media 的 checked-in config 已包含 D1 binding，read/sync 还包含 data R2 binding；sync 的 manual shadow 和 D1-only media V4 会实际访问新资源，read handler 暂不访问。routine deploy 使用稳定的 checked-in `wrangler.toml` 作为唯一源码，不会把临时 deploy config 提交回仓库。

`SNAPSHOT_COORDINATOR` 与 `SUBJECT_REFRESH_COORDINATOR` 是 SQLite-backed Durable Object binding，migration tag 分别为 `snapshot-coordinator-v1` 与 `subject-refresh-coordinator-v1`。migration 只新增 class，不在自动部署或回退中删除。live Workflow 通过前者分配/提交 generation；Media Queue 按 subject ID 路由到后者，并在覆盖 bgm.tv、KV/D1 与 R2 await 的串行互斥区内完成 generation gate、detail/meta/image/R2 副作用、失败状态与完成标记。最高已接受 generation 在任何副作用前持久化，即使新任务失败，迟到旧任务也只能返回 obsolete。V2/legacy 与 live V3 继续使用既有未加前缀的 number generation 围栏，因此在线升级会继承原 Durable Object 状态，generation 0 的兼容消息不能覆盖已接受的更高 V3。D1-only V4 使用独立的 `v4:` 围栏 key 和 `{ observed_at, run_id }` generation；其中 `observed_at` 来自持久化的完整同步观察时间，`run_id` 来自稳定 Workflow instance ID，同一运行重放不会受 retry 时钟影响，排序先比较 `observed_at` 再比较 `run_id`。V3 与 V4 围栏互不推进：V3 保持 live legacy KV 行为，只有 V4 进入 D1-only 路径。真正无 `version` 字段的历史消息继续走 legacy 兼容路径；一旦消息带有 `version`，它必须严格匹配 V2、V3 或 V4，否则 direct、Queue 与 Durable Object 边界都会在任何 KV、D1、R2 或上游副作用前 fail closed。

CI 不上传运行时 secret，也不会手写 `curl` 修改 schedule。定时配置只来自 `apps/sync-worker/wrangler.toml` 的 `[triggers].crons`；Cron handler 只创建 Workflow instance。

部署流水线只负责 typecheck/test/build、解析已有资源、在任何 Worker upload 前应用 remote D1 migrations，再按 read/media → sync + Workflow → control-plane describe → frontend 的顺序部署。migration、resolve 或任一 deploy job 失败时，下游 upload 由 `needs` 链阻断，`recovery_report` 汇总部署版本与精确同-SHA收敛命令。部署完成后不会触发业务同步、不会轮询 KV，也不等待媒体缓存收敛；首次部署无数据时等待下一次 Worker Cron，或显式触发 live instance。

## 最小配置

### GitHub Actions Secrets

GitHub 只需要两个 **Repository secrets**，用于部署 Cloudflare。

配置位置：

GitHub repo -> Settings -> Secrets and variables -> Actions -> Repository secrets -> New repository secret。

当前 workflow 没有设置 GitHub Actions `environment:`，所以这里不是 Environment secrets。只有以后给 deploy job 增加 `environment: production` 这类环境保护时，才需要改用或补充 Environment secrets。

| 名称 | 说明 |
|------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

`CLOUDFLARE_API_TOKEN` 创建位置：

Cloudflare Dashboard -> My Profile -> API Tokens -> Create custom token。

不要再创建 `CF_API_TOKEN` / `CF_ACCOUNT_ID`。旧文档曾经写过这两个短名，但当前 workflow 只读取 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，和 Wrangler 标准环境变量名保持一致。

当前 workflow 需要的 token 权限：

| 范围 | 权限组 | 级别 | 用途 |
|------|--------|------|------|
| Account | `Workers Scripts` | `Edit` | 部署 4 个 Worker script、Workflow binding 与 Worker Cron trigger |
| Account | `D1` | `Edit` | 手动 bootstrap 创建或复用 D1 database；当前 workflow 共用同一个 token |
| Account | `Workers KV Storage` | `Edit` | 部署 KV binding |
| Account | `Workers R2 Storage` | `Edit` | 部署 R2 binding |
| Account | `Queues` | `Edit` | 部署 Queue binding |
| Account | `Account Settings` | `Read` | 让 Wrangler 解析账户信息 |
| User | `User Details` | `Read` | 让 Wrangler 识别 API token 用户 |

如果 `airing-cal-sync` 部署时报：

```text
Some triggers failed to deploy for airing-cal-sync
/workers/scripts/airing-cal-sync/schedules
```

说明 Worker 代码已经上传，但 token 不能更新 Worker Cron trigger。请重新创建或更新 `CLOUDFLARE_API_TOKEN`，确认：

- token 的 Account Resources 包含 `CLOUDFLARE_ACCOUNT_ID` 对应的 Cloudflare account。
- Account 权限组 `Workers Scripts` 是 `Edit`，不是 `Read`。
- 更新 GitHub Repository secret `CLOUDFLARE_API_TOKEN` 后重新跑 workflow。

Wrangler 本地权限映射把 `workers_scripts:write` 描述为可修改 Workers scripts、subdomains、triggers 等，当前 Worker Cron 走这类控制面权限。若日志返回 `workflow.cron_requires_paid_plan`，说明误用了付费的原生 Workflow schedule；仓库配置不得出现 `[[workflows]].schedules`。GitHub Actions 里的 Node 20 deprecation 提示不是这次失败原因。

如果要让 CI 同时部署自定义域名或 route，再额外加这个可选权限：

| 范围 | 权限组 | 级别 | 什么时候需要 |
|------|--------|------|------------|
| Zone | `Workers Routes` | `Edit` | `wrangler.toml` 里配置 `routes`、custom domain，或希望 CI 绑定域名时 |

### Cloudflare Worker 变量

只需要在 `airing-cal-sync` 配 bgm.tv 运行时信息：

| 名称 | 类型 | 说明 |
|------|------|------|
| `BANGUMI_TOKEN` | Secret | bgm.tv access token |
| `BANGUMI_USERS` | Variable | bgm 用户名，多个用户用英文逗号分隔 |

不用在 `airing-cal-media` 配 `BANGUMI_TOKEN`；media-worker 只下载图片和读取可选 subject detail，不需要 access token。

`BANGUMI_TOKEN` 获取方式：

1. 登录需要同步收藏的 Bangumi 账号。
2. 打开 `https://next.bgm.tv/demo/access-token`。
3. 生成并复制页面显示的 Access Token。
4. 到 Cloudflare Dashboard 打开 `airing-cal-sync` Worker，在 Variables and Secrets 中新增 Secret：
   - 名称：`BANGUMI_TOKEN`
   - 值：刚复制的 Access Token

`BANGUMI_USERS` 获取方式：

1. 打开需要同步的 Bangumi 用户主页。
2. 从主页 URL 里取 `/user/` 后面的用户名。例如 `https://bgm.tv/user/sai` 对应 `sai`。
3. 到 Cloudflare Dashboard 打开 `airing-cal-sync` Worker，在 Variables and Secrets 中新增 Variable：
   - 名称：`BANGUMI_USERS`
   - 值：用户名；多个用户用英文逗号分隔，例如 `sai,another_user`

注意：

- `BANGUMI_TOKEN` 要有权限读取这些用户的收藏；私有收藏需要对应授权。
- 如果只同步自己的账号，`BANGUMI_USERS` 填自己的 Bangumi 用户名即可。
- 这两个值都只配置在 `airing-cal-sync`，不要在 GitHub Actions secrets 或其他 3 个 Worker 里重复配置。

其余配置已经写在 repo：

- `SYNC_MODE = "merge"` 在 `apps/sync-worker/wrangler.toml`
- 4 个 Worker 都设置了 `keep_vars = true`，CI 部署不会擦掉 Dashboard 里的运行时变量

可选配置：

| 名称 | 配置位置 | 说明 |
|------|----------|------|
| `NSFW_SHOW=false` | `airing-cal-read` Variable | 不展示 R18 内容；不设置时默认展示 |
| `BANGUMI_GIT_COMMIT_SHA` | `airing-cal-frontend` Variable | 可选；footer 显示并链接当前 commit |
| `BANGUMI_GIT_REPOSITORY_URL` | `airing-cal-frontend` Variable | 可选；footer commit link 的 GitHub 仓库地址 |
| `BANGUMI_GOOGLE_SITE_VERIFICATION` | `airing-cal-frontend` Variable | 可选；输出 Google site verification meta |
| `BANGUMI_YANDEX_VERIFICATION` | `airing-cal-frontend` Variable | 可选；输出 Yandex verification meta |
| `BANGUMI_BING_SITE_VERIFICATION` | `airing-cal-frontend` Variable | 可选；输出 Bing `msvalidate.01` meta |
| `BANGUMI_BAIDU_SITE_VERIFICATION` | `airing-cal-frontend` Variable | 可选；输出 Baidu site verification meta |
| `BANGUMI_GA4_ID`、`BANGUMI_CLARITY_ID`、`BANGUMI_YANDEX_METRICA_ID`、`BANGUMI_BAIDU_TONGJI_ID` | `airing-cal-frontend` Variable | 保留项；当前不会输出 analytics script |

绑定自定义域名不需要改任何 repository URL 变量。自定义域名只影响访问入口，应该绑定到 `airing-cal-frontend`；repository URL 只用于页面 footer 的 commit link，不参与路由、service binding、KV/R2/Queue 或域名解析。

## 数据契约

公开 collection/calendar entry 使用新的图片结构：

```json
{
  "images": {
    "common": {
      "hash": "sha256-hex",
      "uri": "/image/sha256-hex",
      "r2_key": "images/sha256-hex/original"
    },
    "large": null
  },
  "image_status": {
    "common": "cached",
    "large": "failed"
  }
}
```

规则：

- 卡片封面默认使用 `images.common.uri`
- `image_status.common` / `image_status.large` 暴露非敏感缓存结果；`image:status:{subject_id}` 只描述真实图片缓存结果，不再承担 Queue 任务进度
- 需要大图时使用 `images.large`
- 图片 hash 是 `sha256(downloaded_image_bytes)` 的小写 hex
- R2 key 固定为 `images/{hash}/original`
- bgm.tv 返回协议相对图片 URL（例如 `//lain.bgm.tv/...`）时，media-worker 下载前会规范化为 `https://...`

D1 migration 当前创建五张主表：

| 表 | Shadow / D1-only media 职责 |
|----|------------------|
| `collection_items` | `(user_id, subject_id)` 收藏权威行、业务 hash、missing/deleted 两次确认状态 |
| `subject_media` | detail/media hash、NSFW、图片源与 R2 引用、refresh/retry 分类状态 |
| `sync_runs` | stage/status、计数、input/public hash、replay manifest 与分类 `error_code` |
| `sync_budget` | `(date, resource)` 的 reserved/consumed 用量 |
| `app_state` | publication pending/verified、cold cursor 与有界 replay artifact |

`sync_budget_reservations` 是 `sync_budget` 的幂等 helper table，不是第六类业务模型。migration 只做 additive schema 变更且不创建二级 index；部署和回退都不执行 destructive reverse migration。

每日 shadow snapshot 在收藏事务提交前读取一次 `subject_media`，并把这次观察到的
detail、NSFW 与合法的 `images/{sha256}/original` 引用冻结进 collection
checkpoint；崩溃重放不会改用稍后到达的媒体状态。detail 缺失、JSON 无效或 subject
ID 不匹配时回退到本轮完整收藏/calendar 数据；subject tombstone 仍以
`nsfw: true` 隐藏内容，并可保留已经验证的图片引用。媒体任务完成后不进行同日二次
发布，其结果最早进入下一次每日 snapshot。

收藏 checkpoint 完整采用后，sync-worker 会在预算预留或 Queue 提交前再持久化一个
有界 `media_pending` replay artifact，冻结本轮规范媒体请求、候选优先级和 cold
cursor 目标。只有 `sync_runs` 精确采用该 manifest 后才允许发生外部提交；若 Queue
已接受后进程丢失，重放使用同一 request/reservation ID，而不会按后来变化的
`subject_media` 重新选取任务。预算幂等状态会返回已存结果并阻止第二次 Queue send，
因此计数与 cursor 也保持原运行语义。

`collections → media_pending → prepared → complete` 的每次状态采用都以当前
stage 与完整 replay manifest 做 D1 compare-and-set；旧并发尝试不能覆盖已采用的
后续阶段。外部提交前还会回读并验证精确 `media_pending` manifest。媒体请求先以
canonical JSON round-trip 后再同时用于 artifact 与首次提交，因此首次与重放的
JSON bytes 一致。请求里的 `date` 只参与审计与幂等 fingerprint；首次预算认领始终按
协调器当前 UTC 日期计费，跨午夜重放不会占用前一天额度。

到期的 V4 检查即使 detail、NSFW、源 URL 与 R2 引用均未变化，也会只推进
`checked_at` 与 `next_refresh_at` 调度水位；图片对象、detail/media hash 和其他
不可变 payload 不重写。hot 下一次检查继续使用现有确定性 6～8 天分散规则，因此
成功检查后的次日不会再次入队；尚未到期的相同内容仍保持 D1/R2 零写。

新 shadow 发布 key：

| 存储 | Key | 当前用途 |
|------|-----|---------|
| data R2 | `snapshots/v1/{generation}-{content_hash}.json` | 不可变 `PublicSnapshotV1`；写后必须回读验证 |
| KV | `public:current` | 只含 version/generation/hash/R2 key/time 的 shadow pointer；当前 read-worker 不读取 |

当前公开读取与兼容 KV key：

| Key | 写入方 | 说明 |
|-----|--------|------|
| `snapshot:collections:{type}` | `airing-cal-sync` | 按 collection type 存的公开 snapshot |
| `snapshot:calendar` | `airing-cal-sync` | 日历 snapshot |
| `snapshot:summary` | `airing-cal-sync` | 数量摘要 |
| `sync:meta` | `airing-cal-sync` | 最近同步元信息 |
| `sync:current` | `SyncWorkflow` | initialize 阶段写入的当前 live instance 与 generation 指针 |
| `sync:run:{instanceId}` | `SyncWorkflow` | instance stage、heartbeat、candidates/by-priority、selected、granted、budget-deferred、confirmed/uncertain、skipped 聚合计数与错误，TTL 3 天 |
| `sync:staging:{instanceId}:*` | `SyncWorkflow` | step 间 payload，TTL 24 小时 |
| `snapshot:shadow:{instanceId}:*` | `SyncWorkflow` | shadow 快照与审计数据，不参与正式读取 |
| `snapshot:version:{instanceId}:*` | `SyncWorkflow` | live 的版本化 snapshot；全部写完后由 `snapshot:active` 原子切换，read-worker 优先读取该版本 |
| `subject:meta:{subject_id}` | `airing-cal-media` | subject detail 与 NSFW 判定 |
| `subject:refresh:{subject_id}` | `airing-cal-sync`, `airing-cal-media` | V2/V3 媒体任务的 queued/running/ok/partial/failed 状态、`job_id` 与 generation 兼容状态 |
| `image:status:{subject_id}` | `airing-cal-media` | subject 的 common/large 缓存状态 |
| `image:index:{hash}` | `airing-cal-media` | hash 到 subject/source metadata 的索引 |

`subject:detail:{subject_id}` 存完整 `GET /v0/subjects/{subject_id}` 响应和 `cached_at`。代码里不要重复从 collection/calendar 的 slim subject 推导 canonical 图片或 NSFW；公共投影入口在 `@airing-cal/domain`：

subject detail 使用 stale-while-revalidate：旧内容在刷新窗口后继续服务，下一次刷新时间按 subject ID 确定性分散到 6 至 8 天；普通 cold 候选再按 7 个 UTC 日轮转，避免同日集中。`MediaRefreshJobV2` 的 `job_id` 由运行 ID 与 subject ID 组成；consumer 会跳过同一 job 的完成态或活动租约，瞬态失败按 30/120/300 秒重试，404 和缺失源图写终态后 ack。Media Queue 每次只取 1 条，`max_batch_timeout = 5`、`max_concurrency = 4`、`max_retries = 3`，避免同时压高 Workers Free Plan 与 bgm.tv 上游负载。

- `subjectDetailImages(subject)`：从完整 subject detail 取 `common` / `large` 源图。
- `subjectMetaFromDetail(subjectId, subject, checkedAt)`：从完整 subject detail 生成 `subject:meta`。
- `withSubjectDetail(subject, detail)`：用完整 subject detail 覆盖 calendar slim subject 的展示字段。

生产 Workflow 直接从 collection/calendar 响应生成版本化公开 snapshot，并有界读取现有 subject detail/meta/image/refresh 状态，在入队前筛除缓存完整且未到期的 subject；它不刷新 `subject:detail:{subject_id}`。Media Worker 只对选中的组件异步执行并在写前比较规范值：缓存完全复用或结果未变化时保持 zero-write，Read Worker 在读取 collection/calendar 时用现有状态补图片并执行 tombstone 投影。

subject detail 返回 404 时会保守缓存为：

```json
{
  "exists": false,
  "nsfw": true,
  "reason": "not_found",
  "expires_at": 1780000000
}
```

新 tombstone 的抑制 TTL 是 24 小时：TTL 内不重复请求 subject detail；到期只代表允许重新排队和探测，不代表旧 detail 或图片可以恢复公开。只要 metadata 仍是 confirmed-not-found，Read 和 Sync 都保持 fail-closed，Media 的恢复探测若返回 404、401/403 或其他失败也不会继续处理旧图片；只有成功取得新 detail 并写入存在状态后才解除屏蔽。旧数据中的 `reason: "not_found_or_restricted"` 同样按 confirmed-not-found 处理，并立即安排一次迁移探测。

## 本地开发与验证

安装和验证：

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:check
```

单独检查某个 Worker：

```bash
pnpm -F @airing-cal/frontend-worker cf:types
pnpm -F @airing-cal/frontend-worker build:check
```

每个 app 都使用自己的 `wrangler.toml`。`build:check` 会执行：

```text
wrangler types worker-configuration.d.ts --check --config wrangler.toml
wrangler deploy --dry-run --outdir dist --config wrangler.toml
```

## CI 部署流程

### CI 验证触发

`.github/workflows/ci.yml` 只在推送到 `dev` 时触发 push 验证，并在所有 `pull_request` 事件上触发验证，不配置路径过滤。这样 PR 分支的后续 push 只由 PR 验证覆盖，合并到 `dev` 后仍会进行一次验证。CI 使用 `${{ github.workflow }}-${{ github.ref }}` 作为 workflow 级并发组并启用取消：同一 workflow 和 ref 的较新提交会取消旧的进行中验证，而不会取消其他 workflow 的运行。

`.github/workflows/deploy.yml` 会按顺序执行：

1. 在不接触 production secrets 的 `resolve_ref` job 中把 push SHA 或手动 ref 解析为完整 commit SHA，并验证它已是 `origin/dev` 的 ancestor
2. 所有后续 job checkout 同一个解析 SHA，运行 `pnpm install --frozen-lockfile`、typecheck、test、build check
3. 解析既有 Cloudflare 资源，并在任何 Worker 上传前运行 Worker Cron 配额 preflight
4. 用 resolver 输出 materialize sync config，执行 `wrangler d1 migrations apply AIRING_CAL_D1 --remote`；失败时不开始任何 Worker upload
5. 并行部署 `airing-cal-read` 与 `airing-cal-media`
6. 部署 `airing-cal-sync`、`SyncWorkflow` 与 Durable Object migrations，运行 `wrangler workflows describe` 检查控制面
7. 以解析 SHA 注入 commit/repository build vars，最后部署 `airing-cal-frontend`

手动部署输入可以是 SHA、branch 或 tag，但解析出的 commit 必须已经进入 `dev` 历史；未进入 `dev` 的 ref 会在 secrets 和 Cloudflare job 启动前失败。`dev` 在部署期间继续前进不会改变本次 revision，页面 footer SHA 与实际 checkout/deploy SHA保持一致。Cron trigger 已达到 Free Plan 上限且 `airing-cal-sync` 没有可复用 trigger 时，preflight 会在首个 upload 前终止，避免部分部署。

部署步骤直接运行 `pnpm exec wrangler deploy`，不再通过 `cloudflare/wrangler-action` 包装。CI 会设置 `WRANGLER_LOG=debug` 和 `WRANGLER_LOG_PATH`；如果部署失败，会打印脱敏后的 Wrangler debug log。随后 `recovery_report` 查询四个 Worker 当前 deployment JSON、汇总各部署 job 结果，并输出使用本次已解析完整 SHA 的精确收敛命令 `gh workflow run deploy.yml --ref dev -f ref=<resolved-sha>`；需要回退时按下方 runbook 操作。

这个顺序保证 additive D1 migration 先完成，内部 read/media/sync Worker 与 Workflow 控制面再更新，最后才更新公开入口 frontend Worker。部署不创建 live instance；业务同步由 schedule 或显式手动 trigger 独立执行。首次部署时 frontend 的 service binding 需要 read/sync Worker 已存在，所以 frontend 不放进并行 matrix。

### 正式回退 runbook

1. 在 Cloudflare Dashboard 暂停 `airing-cal-sync` 的 Worker Cron trigger，防止回退期间创建新的 live instance。
2. 用 `pnpm exec wrangler workflows instances describe airing-cal-sync <instance-id> --config apps/sync-worker/wrangler.toml` 核对异常实例；确认后执行 `pnpm exec wrangler workflows instances terminate airing-cal-sync <instance-id> --config apps/sync-worker/wrangler.toml`。这两个命令只操作 Workflow instance，不删除 KV、R2、Queue 或 Durable Object。
3. 选择本次发布前一个已知稳定、仍兼容现有 D1 schema、Workflow 和 Durable Object binding 的完整 40 位 commit SHA（通常是上一生产 SHA）。它必须已经进入 `dev` 历史；不要使用尚未进入 `dev` 的分支、tag 或可移动 ref，部署 workflow 会再次执行 ancestor 校验。
4. 在 GitHub Actions 手动运行 `Deploy to Cloudflare`，把 `ref` 填为该完整 SHA。所有 job 会 checkout 同一 SHA，Cron quota preflight 通过后按既定顺序部署。
5. 核对 deploy log 中 `SnapshotCoordinator`、`SubjectRefreshCoordinator` binding 与 `snapshot-coordinator-v1`、`subject-refresh-coordinator-v1` migration 可加载；再检查 `workflows describe`、公开 `/api/health`、`sync:current` 与 `snapshot:active.generation`。generation 不得倒退，active manifest 必须能完整读取。
6. 确认公开页面 footer SHA等于所选稳定 SHA、health 与 active snapshot 正常后，再在 Cloudflare Dashboard 恢复 Worker Cron trigger。

回退只回退 runtime，不回退数据。不得 reverse 或删除已经应用的 D1 migration，不得删除/覆盖 `airing-cal-state`、两个 R2 bucket、KV、Queue、Workflow 或 SQLite Durable Object migration；shadow 产生的 D1 rows、R2 objects 与 pointer 保留供前向恢复和审计。稳定 SHA中的 Worker module 必须继续导出两个 class并保留 binding，使已经创建的 namespace 可加载；若前一个 SHA早于当前 D1/schema/binding 兼容边界，不得直接部署它，应先制作保留新 schema/class/binding 的兼容回退提交并进入 `dev`。

## Cache 与 NSFW

`/api/cache` 是公开且脱敏的缓存状态 JSON。它使用 opaque KV cursor 分页，合法 cursor 会原样传给 KV；`limit` 最大 100，并以固定并发读取当前页 image status。响应中的 `page_subjects` 是当前页条目数，`cursor` 为 `null` 表示已到最后一页。它不暴露 access token、上游认证响应体或未清理的错误信息。

`/api/collections` 的 `type`、`page`、`limit` 与 `/api/cache` 的 `limit`、`cursor` 都执行完整格式验证；这些参数重复出现也会被拒绝。未知 collection type、非正整数、超出上限、空或含 U+0000–U+001F、U+007F–U+009F 控制字符的 cursor 等非法 query 返回 HTTP 400 和稳定的 `INVALID_QUERY` JSON 错误，不会静默采用默认值。此类错误响应显式使用 `Cache-Control: no-store`。

页面 footer 不读取完整 `/api/cache` 明细；`/src/cache.js` 只读取 `/api/health` 中的轻量 cache 摘要与同步状态，避免为了展示 footer 触发大量 KV image status 读取。

`airing-cal-media` 会抓取 subject detail 做 NSFW enrichment。受限或不存在的 subject 会按 NSFW 处理，避免误展示为安全内容。

## Widget

Widget 的唯一来源是 `packages/widget`。公开 HTML 页面复用同一个 footer renderer。

CI 部署 frontend 时会把 `BANGUMI_GIT_COMMIT_SHA` 和 `BANGUMI_GIT_REPOSITORY_URL` 注入临时 Wrangler config，footer 会链接到对应 commit；本地或自定义部署没有提供这两个值时会显示 `Build unknown`。这只是页面追踪构建来源的信息，不影响部署和访问。

浏览器 widget 使用 `images.common.uri` 渲染封面。没有缓存图片时读取 `image_status.common` 显示 `image pending`、`image queued`、`image missing source` 或 `image cache failed`，不内嵌 `data:image` placeholder。

浏览器 widget 也包含动画同步视图。同步请求只打到 frontend 的 `/api/sync/compare`、`/api/sync/apply` 和 `/api/check/:id`，再由 service binding 转给 `airing-cal-sync` 的内部路由。

Analytics 环境变量目前是保留项，代码不会注入 GA4、Clarity、Yandex Metrica 或 Baidu Tongji 脚本；这避免在没有官方片段验证前输出假的占位注释。

## 致谢

- [bangumi/api](https://github.com/bangumi/api) 提供 API
- [GeeKaven/BangumiTV](https://github.com/GeeKaven/BangumiTV) 原始项目
