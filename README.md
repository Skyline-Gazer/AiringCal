# AiringCal

> 在静态页面中渲染你的 Bangumi 追番进度。

AiringCal 是一个 Cloudflare Workers monorepo。它把公开访问、只读数据、定时同步、媒体补全拆成 4 个独立 Worker，让公开页面、KV/R2 读取、bgm.tv 抓取、图片下载分别使用自己的 Worker 调用预算。

## 架构

部署后会有 4 个独立 Worker：

| Worker | 目录 | 职责 |
|--------|------|------|
| `airing-cal-frontend` | `apps/frontend-worker` | 唯一公开入口，提供页面、widget 静态资源、BFF JSON route 和 `/image/:hash` 代理 |
| `airing-cal-read` | `apps/read-worker` | 内部只读 API，只从 KV/R2 读取 snapshot、配置、健康状态、缓存统计和图片 |
| `airing-cal-sync` | `apps/sync-worker` | Cloudflare Workflow 持久化编排 collection/calendar、版本化 snapshot 和 Media Queue 候选任务 |
| `airing-cal-media` | `apps/media-worker` | Queue consumer，下载 common/large 图片，写 R2，更新 image/subject meta KV |

共享 package：

| Package | 职责 |
|---------|------|
| `@airing-cal/bgm-api` | bgm.tv client、OpenAPI 对齐的类型、API helpers |
| `@airing-cal/domain` | snapshot merge、image ref、subject meta、queue/data contracts |
| `@airing-cal/storage` | KV/R2 adapter 和 key builder |
| `@airing-cal/widget` | HTML shell、footer runtime status、widget JS/CSS assets |
| `@airing-cal/worker-common` | public error、安全 header、敏感信息清理、部署/文档守护测试 |

Widget 资产的唯一手写源是 `packages/widget/assets/theme/{bangumi.js,bangumi.css,cache.js}`，唯一运行时生成产物是 `packages/widget/src/generated-assets.ts`。修改主题源后运行：

```bash
pnpm -F @airing-cal/widget generate
```

生成链测试会拒绝生成产物漂移，也会拒绝重新引入 `assets/public` 或 `assets/theme/v1` 副本。

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

scheduled live 与 manual live 共享同一个 UTC 自然日预算，没有强制绕过 hard limit 的参数。`SNAPSHOT_COORDINATOR` 先以稳定 reservation 预留逻辑预算，再最多调用一次 Queue producer；Queue 确认结果不确定时按 fail-closed 保留预算并标记 uncertain，不重发同一 reservation，但仍提交 collection/calendar snapshot。未变化 subject 不产生逐 subject KV 写入，也不投递媒体任务。Workflow 只读逐 subject 媒体状态，实际 detail/meta/image/refresh 写入仍由 Media Worker 执行。401/403 立即终止，429、5xx、timeout 和网络错误由网络 step 最多重试 3 次。部署顺序固定为 read/media → sync + Workflow → `workflows describe` → frontend，部署完成仍不会自动创建业务 instance。

收藏页不会在每次浏览页面时实时请求 bgm.tv。Workflow 以 `limit=50` 获取 collections 并按 bgm.tv `type` 发布 `want`、`watched`、`watching`、`on_hold`、`dropped` 版本化快照；读取端跟随 `snapshot:active` 读取同一个 instance 的五类 collections、calendar 和 summary，并在返回数据前验证 manifest 恰好列出这 7 个 required key 及其 SHA-256 digest。带有任一 V3 字段（`generation`、`required_keys`、`digests`）的 active manifest、key 或 digest 不完整时返回 HTTP 503 `SNAPSHOT_INCOMPLETE`，绝不逐 key 混入 legacy 数据；active 完全不存在，或旧 active pointer 同时不含上述三个 V3 字段时，才整套读取 legacy snapshot。Workflow 不请求 subject detail；detail、metadata 和图片由 Media Queue 以 stale-while-revalidate 方式异步收敛。

collections 使用 bgm.tv OpenAPI 允许的 `limit=50` 分页，并受 120 秒整体预算约束。bgm.tv JSON GET 请求单次 timeout 为 10 秒；429、5xx、timeout 和网络错误最多重试 2 次，401/403 不重试，POST/PATCH 写请求也不会被 client 隐式重试。

`/api/health` 仍保留 `data.cron.last` 作为迁移兼容字段，`data.cron.next_at` 按每日 20:00 UTC 计算；最近 instance 优先来自 initialize 阶段写入的 `sync:current`，因此 running 或硬中断实例不必等待 finalize 才可见。最近 instance 来自 schedule 时，cron 字段由对应 Workflow run 的同一个 effective status 派生，不再返回旧 Queue 遗留状态或出现 `stale/running` 分裂。`data.collections.updated_at` 优先使用当前 active snapshot 的发布时间。新的权威应用状态仍是 `data.workflow`，Cloudflare 控制面状态是最终依据。

`/api/health` 的 `data.workflow` 暴露最近 instance 的 `instance_id`、mode、source、stage、heartbeat、完成时间、计数和脱敏错误。聚合计数包含 eligible candidates `refresh_candidates` 及 `refresh_candidates_by_priority`、planner 选中 `refresh_selected`、逻辑获批 `refresh_granted`、预算留待后续 `refresh_deferred`（等于 `refresh_candidates - refresh_granted`）、producer 已确认/不确定的 `refresh_confirmed` / `refresh_uncertain`，以及预留前跳过的 `refresh_skipped`（等于 `subject_count - refresh_candidates`）。`refresh_jobs` 是 `refresh_granted` 的兼容 alias，只表示逻辑预算获批，不表示 Queue 一定物理接收；异步 consumer 的真实 KV PUT 只能从 consumer 与 Cloudflare 指标观察，Workflow 不推算实际写入数。成功或失败 run 都保留已到达的最新聚合值；这些字段只写入已有 run 记录，不创建逐 subject 指标 key。`queued`、`running` 或 `retrying` run 超过 20 分钟没有 heartbeat 时，应用侧返回 `status: "stale"` 与 `stale: true`；实际恢复、重启或终止仍以 Cloudflare Workflow instance 控制面状态为准。

Worker Cron 来自 checked-in `wrangler.toml`；routine deploy 只同步代码与配置，不主动触发 live instance。

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
| `airing-cal-read` | `AIRING_CAL_KV`, `AIRING_CAL_R2` |
| `airing-cal-sync` | `AIRING_CAL_KV`, `MEDIA_QUEUE`, `SYNC_WORKFLOW`, `SNAPSHOT_COORDINATOR` |
| `airing-cal-media` | `AIRING_CAL_KV`, `AIRING_CAL_R2`, `SUBJECT_REFRESH_COORDINATOR` |

Cloudflare 资源创建已经与常规部署分离。首次部署或资源缺失时，在 GitHub Actions 中手动运行 `Bootstrap Cloudflare Resources`（手动 bootstrap workflow）：

- 创建或复用 KV namespace `airing-cal-kv`，并把实际 namespace ID 注入后续 Worker deploy config。
- 创建或复用 D1 database `airing-cal-state`，并记录其 Cloudflare UUID。
- 创建或复用 R2 data bucket `airing-cal-data`。
- 创建或复用 R2 bucket `airing-cal-images`。
- 创建或复用 Queue `airing-cal-media`。
- 后续 Wrangler deploy 会按 checked-in 配置确认 `airing-cal-frontend` 的 service bindings 指向 `airing-cal-read` 和 `airing-cal-sync`。

KV 比较特殊：`wrangler.toml` 里的 `kv_namespaces.id` 不是 namespace title，而是 Cloudflare 生成的 namespace ID。仓库里的 3 个 Worker config 保留占位符：

```toml
id = "<AIRING_CAL_KV_NAMESPACE_ID>"
```

常规 deploy 只读解析实际 KV namespace ID，同时验证 D1、两个 R2 bucket、KV 与 Queue；资源不存在时会明确失败并提示先运行 bootstrap，不会在发布途中创建资源。当前兼容阶段只创建并验证 D1/data R2，checked-in Worker config 尚未添加 D1 或 data R2 runtime binding，也不会访问这些资源。routine deploy 使用稳定的 checked-in `wrangler.toml` 作为唯一源码，不会把临时 deploy config 提交回仓库。

`SNAPSHOT_COORDINATOR` 与 `SUBJECT_REFRESH_COORDINATOR` 是 SQLite-backed Durable Object binding，migration tag 分别为 `snapshot-coordinator-v1` 与 `subject-refresh-coordinator-v1`。migration 只新增 class，不在自动部署或回退中删除。live Workflow 通过前者分配/提交 generation；Media Queue 按 subject ID 路由到后者，并在覆盖 bgm.tv、KV 与 R2 await 的串行互斥区内完成 generation gate、detail/meta/image/R2 副作用、失败状态与完成标记。最高已接受 generation 在任何副作用前持久化，即使新任务失败，迟到旧任务也只能返回 obsolete。V2/legacy 消息按 generation 0 兼容，不能覆盖已经接受的更高 V3 generation。

CI 不上传运行时 secret，也不会手写 `curl` 修改 schedule。定时配置只来自 `apps/sync-worker/wrangler.toml` 的 `[triggers].crons`；Cron handler 只创建 Workflow instance。

部署流水线只负责 typecheck/test/build、解析已有资源、按 read/media → sync + Workflow → control-plane describe → frontend 的顺序部署。部署完成后不会触发业务同步、不会轮询 KV，也不等待媒体缓存收敛；首次部署无数据时等待下一次 Worker Cron，或显式触发 live instance。

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

KV key：

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

`.github/workflows/deploy.yml` 会按顺序执行：

1. 在不接触 production secrets 的 `resolve_ref` job 中把 push SHA 或手动 ref 解析为完整 commit SHA，并验证它已是 `origin/dev` 的 ancestor
2. 所有后续 job checkout 同一个解析 SHA，运行 `pnpm install --frozen-lockfile`、typecheck、test、build check
3. 解析既有 Cloudflare 资源，并在任何 Worker 上传前运行 Worker Cron 配额 preflight
4. 并行部署 `airing-cal-read` 与 `airing-cal-media`
5. 部署 `airing-cal-sync`、`SyncWorkflow` 与 Durable Object migrations，运行 `wrangler workflows describe` 检查控制面
6. 以解析 SHA 注入 commit/repository build vars，最后部署 `airing-cal-frontend`

手动部署输入可以是 SHA、branch 或 tag，但解析出的 commit 必须已经进入 `dev` 历史；未进入 `dev` 的 ref 会在 secrets 和 Cloudflare job 启动前失败。`dev` 在部署期间继续前进不会改变本次 revision，页面 footer SHA 与实际 checkout/deploy SHA保持一致。Cron trigger 已达到 Free Plan 上限且 `airing-cal-sync` 没有可复用 trigger 时，preflight 会在首个 upload 前终止，避免部分部署。

部署步骤直接运行 `pnpm exec wrangler deploy`，不再通过 `cloudflare/wrangler-action` 包装。CI 会设置 `WRANGLER_LOG=debug` 和 `WRANGLER_LOG_PATH`；如果部署失败，会打印脱敏后的 Wrangler debug log。随后 `recovery_report` 查询四个 Worker 当前 deployment JSON、汇总各部署 job 结果，并输出使用本次已解析完整 SHA 的精确收敛命令 `gh workflow run deploy.yml --ref dev -f ref=<resolved-sha>`；需要回退时按下方 runbook 操作。

这个顺序保证内部 read/media/sync Worker 与 Workflow 控制面先更新，再更新公开入口 frontend Worker。部署不创建 live instance；业务同步由 schedule 或显式手动 trigger 独立执行。首次部署时 frontend 的 service binding 需要 read/sync Worker 已存在，所以 frontend 不放进并行 matrix。

### 正式回退 runbook

1. 在 Cloudflare Dashboard 暂停 `airing-cal-sync` 的 Worker Cron trigger，防止回退期间创建新的 live instance。
2. 用 `pnpm exec wrangler workflows instances describe airing-cal-sync <instance-id> --config apps/sync-worker/wrangler.toml` 核对异常实例；确认后执行 `pnpm exec wrangler workflows instances terminate airing-cal-sync <instance-id> --config apps/sync-worker/wrangler.toml`。这两个命令只操作 Workflow instance，不删除 KV、R2、Queue 或 Durable Object。
3. 从 `dev` 历史选择已知稳定的完整 40 位 commit SHA。不要使用尚未进入 `dev` 的分支、tag 或可移动 ref；部署 workflow 会再次执行 ancestor 校验。
4. 在 GitHub Actions 手动运行 `Deploy to Cloudflare`，把 `ref` 填为该完整 SHA。所有 job 会 checkout 同一 SHA，Cron quota preflight 通过后按既定顺序部署。
5. 核对 deploy log 中 `SnapshotCoordinator`、`SubjectRefreshCoordinator` binding 与 `snapshot-coordinator-v1`、`subject-refresh-coordinator-v1` migration 可加载；再检查 `workflows describe`、公开 `/api/health`、`sync:current` 与 `snapshot:active.generation`。generation 不得倒退，active manifest 必须能完整读取。
6. 确认公开页面 footer SHA等于所选稳定 SHA、health 与 active snapshot 正常后，再在 Cloudflare Dashboard 恢复 Worker Cron trigger。

回退不得删除或回滚 SQLite Durable Object migration。稳定 SHA中的 Worker module 必须继续导出两个 class 并保留 binding，使已经创建的 namespace 可加载；若某个旧 SHA早于 coordinator 引入提交，不得直接部署它，应先制作一个保留新 class/binding 的兼容回退提交并进入 `dev`。

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
