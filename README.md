# AiringCal

> 在静态页面中渲染你的 Bangumi 追番进度。

AiringCal 是一个 Cloudflare Workers monorepo。它把公开访问、只读数据、定时同步、媒体补全拆成 4 个独立 Worker，让公开页面、KV/R2 读取、bgm.tv 抓取、图片下载分别使用自己的 Worker 调用预算。

## 架构

部署后会有 4 个独立 Worker：

| Worker | 目录 | 职责 |
|--------|------|------|
| `airing-cal-frontend` | `apps/frontend-worker` | 唯一公开入口，提供页面、widget 静态资源、BFF JSON route 和 `/image/:hash` 代理 |
| `airing-cal-read` | `apps/read-worker` | 内部只读 API，只从 KV/R2 读取 snapshot、配置、健康状态、缓存统计和图片 |
| `airing-cal-sync` | `apps/sync-worker` | Cloudflare Cron 定时同步 collection/calendar，写 snapshot，并把媒体任务送入 Queue |
| `airing-cal-media` | `apps/media-worker` | Queue consumer，下载 common/large 图片，写 R2，更新 image/subject meta KV |

共享 package：

| Package | 职责 |
|---------|------|
| `@airing-cal/bgm-api` | bgm.tv client、OpenAPI 对齐的类型、API helpers |
| `@airing-cal/domain` | snapshot merge、image ref、subject meta、queue/data contracts |
| `@airing-cal/storage` | KV/R2 adapter 和 key builder |
| `@airing-cal/widget` | HTML shell、footer、cache page、widget JS/CSS assets |
| `@airing-cal/worker-common` | public error、安全 header、敏感信息清理、部署/文档守护测试 |

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
| `/cache` | 公开、脱敏后的缓存统计页 |
| `/src/bangumi.js` | Widget script |
| `/src/bangumi.css` | Widget styles |
| `/src/cache.js` | Cache page script |
| `/api/collections?type=watching` | 通过 `READ_WORKER` 读取 collection snapshot |
| `/api/calendar` | 通过 `READ_WORKER` 读取 calendar snapshot |
| `/api/config?key=nsfw` | 通过 `READ_WORKER` 读取公开配置 |
| `/api/health` | 通过 `READ_WORKER` 读取健康状态 |
| `/api/cache` | 通过 `READ_WORKER` 读取脱敏缓存 JSON |
| `/api/sync/compare` | 通过 `SYNC_WORKER` 执行动画收藏对比 |
| `/api/sync/apply` | 通过 `SYNC_WORKER` 执行动画收藏同步并写操作日志 |
| `/api/check/:id` | 通过 `SYNC_WORKER` 查询 24 小时内的同步操作日志 |
| `/image/:hash` | 通过 `READ_WORKER` 读取 R2 图片 |

`airing-cal-sync` 没有公开同步 URL；生产同步由 Cloudflare Cron 触发：

```toml
[triggers]
crons = ["0 * * * *"]
```

Cloudflare 免费计划对 Cron Trigger 数量有限制，所以这里只配置 1 个每小时触发器；`sync-worker` 会在代码里只允许 UTC 0/4/8/12/16/20 点真正同步，其余小时直接跳过。

查看当前 Cloudflare account 里哪些 Worker 占用了 Cron Trigger 可以用 Cloudflare Dashboard 或 Wrangler 手动检查；routine deploy 不会自动创建、删除或迁移 schedule。

## Cloudflare 资源

当前约定的 Cloudflare 资源名：

| 类型 | 名称 |
|------|------|
| KV namespace title | `airing-cal-kv` |
| R2 bucket | `airing-cal-images` |
| Queue | `airing-cal-media` |
| Service binding | `READ_WORKER -> airing-cal-read` |
| Service binding | `SYNC_WORKER -> airing-cal-sync` |

当前绑定名：

| Worker | Binding |
|--------|---------|
| `airing-cal-frontend` | `READ_WORKER`, `SYNC_WORKER` |
| `airing-cal-read` | `AIRING_CAL_KV`, `AIRING_CAL_R2` |
| `airing-cal-sync` | `AIRING_CAL_KV`, `MEDIA_QUEUE` |
| `airing-cal-media` | `AIRING_CAL_KV`, `AIRING_CAL_R2` |

CI/CD 会创建或复用 Cloudflare 资源：

- 创建或复用 KV namespace `airing-cal-kv`，并把实际 namespace ID 注入后续 Worker deploy config。
- 创建或复用 R2 bucket `airing-cal-images`。
- 创建或复用 Queue `airing-cal-media` 与 `airing-cal-sync-trigger`。
- 确认 `airing-cal-frontend` 的 service bindings 指向 `airing-cal-read` 和 `airing-cal-sync`。

KV 比较特殊：`wrangler.toml` 里的 `kv_namespaces.id` 不是 namespace title，而是 Cloudflare 生成的 namespace ID。仓库里的 3 个 Worker config 保留占位符：

```toml
id = "<AIRING_CAL_KV_NAMESPACE_ID>"
```

部署时 CI 会自动获取实际 KV namespace ID，注入临时 deploy config，再交给 Wrangler dry-run/deploy。routine deploy 使用稳定的 checked-in `wrangler.toml` 作为唯一源码，不会把临时 deploy config 提交回仓库。

CI 仍然不会上传运行时 secret，也不会手写 `curl` 去改 cron schedule。Cron schedule 只来自 `apps/sync-worker/wrangler.toml` 的 `[triggers]`；部署 `airing-cal-sync` 时，Wrangler 会自动把这个配置同步到 Cloudflare Cron Triggers。

部署完成后不会自动投递同步消息。首次部署如果页面暂时显示“KV 无数据”，等待下一个有效 Cron tick，或在 widget 的动画同步视图中使用两个 bgm.tv access token 手动执行同步。

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
| Account | `Workers Scripts` | `Edit` | 部署 4 个 Worker script，并更新 `airing-cal-sync` 的 Cron Trigger |
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

说明 Worker 代码已经上传，但这个 token 不能更新 Cron Trigger。请重新创建或更新 `CLOUDFLARE_API_TOKEN`，确认：

- token 的 Account Resources 包含 `CLOUDFLARE_ACCOUNT_ID` 对应的 Cloudflare account。
- Account 权限组 `Workers Scripts` 是 `Edit`，不是 `Read`。
- 更新 GitHub Repository secret `CLOUDFLARE_API_TOKEN` 后重新跑 workflow。

Wrangler 本地权限映射把 `workers_scripts:write` 描述为可修改 Workers scripts、subdomains、triggers 等；Cron schedule 部署走的就是 triggers/schedules 这一类权限。GitHub Actions 里的 Node 20 deprecation 提示不是这次失败原因。

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
- `image_status.common` / `image_status.large` 暴露非敏感缓存状态，便于区分 `cached`、`pending_next_cron`、`queued`、`failed` 和 `missing_source`
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
| `subject:meta:{subject_id}` | `airing-cal-media` | subject detail 与 NSFW 判定 |
| `image:status:{subject_id}` | `airing-cal-media` | subject 的 common/large 缓存状态 |
| `image:index:{hash}` | `airing-cal-media` | hash 到 subject/source metadata 的索引 |

`subject:detail:{subject_id}` 存完整 `GET /v0/subjects/{subject_id}` 响应和 `cached_at`。代码里不要重复从 collection/calendar 的 slim subject 推导 canonical 图片或 NSFW；公共投影入口在 `@airing-cal/domain`：

- `subjectDetailImages(subject)`：从完整 subject detail 取 `common` / `large` 源图。
- `subjectMetaFromDetail(subjectId, subject, checkedAt)`：从完整 subject detail 生成 `subject:meta`。
- `withSubjectDetail(subject, detail)`：用完整 subject detail 覆盖 calendar slim subject 的展示字段。

`airing-cal-sync` 会为 collections 和 calendar 发现到的 subject id 复用/刷新 `subject:detail:{subject_id}`，再生成公开 snapshot。collections 的名称、简介、日期和集数字段也优先来自完整 subject detail；`airing-cal-read` 只做 image/meta 状态 hydration，不再在请求时读取 `subject:detail` 补展示字段。

subject detail 返回 404 时会保守缓存为：

```json
{
  "exists": false,
  "nsfw": true,
  "reason": "not_found_or_restricted"
}
```

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

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build:check`
5. 用 matrix 部署 `airing-cal-read`、`airing-cal-media`、`airing-cal-sync`
6. 向 `airing-cal-sync-trigger` 推送一次同步触发，并等待 `snapshot:calendar` 中的 subject 都有可观测 common 图片管线状态（`queued` / `cached` / `failed` / `missing_source`）
7. 最后部署 `airing-cal-frontend`

部署步骤直接运行 `pnpm exec wrangler deploy`，不再通过 `cloudflare/wrangler-action` 包装。CI 会设置 `WRANGLER_LOG=debug` 和 `WRANGLER_LOG_PATH`；如果部署失败，会打印脱敏后的 Wrangler debug log，便于看到 Cloudflare API 返回的真实错误。

这个顺序保证内部 read/media/sync Worker 先更新，部署后立刻启动一次 snapshot/media cache 收敛，最后再更新公开入口 frontend Worker。首次部署时，`airing-cal-frontend` 的 service binding 需要目标 `airing-cal-read` 和 `airing-cal-sync` 已经存在，所以 frontend 不放进并行 matrix。

## Cache 与 NSFW

`/cache` 是公开且脱敏的缓存状态页。它只展示聚合后的缓存状态，不暴露 access token、上游认证响应体或未清理的错误信息。

`airing-cal-media` 会抓取 subject detail 做 NSFW enrichment。受限或不存在的 subject 会按 NSFW 处理，避免误展示为安全内容。

## Widget

Widget 的唯一来源是 `packages/widget`。公开 HTML 页面复用同一个 footer renderer。

如果部署环境提供 `BANGUMI_GIT_COMMIT_SHA` 和 `BANGUMI_GIT_REPOSITORY_URL`，footer 会链接到对应 commit；否则显示 `Build unknown`。这只是页面追踪构建来源的可选信息，不影响部署和访问。

浏览器 widget 使用 `images.common.uri` 渲染封面。没有缓存图片时读取 `image_status.common` 显示 `image pending`、`image queued`、`image missing source` 或 `image cache failed`，不内嵌 `data:image` placeholder。

浏览器 widget 也包含动画同步视图。同步请求只打到 frontend 的 `/api/sync/compare`、`/api/sync/apply` 和 `/api/check/:id`，再由 service binding 转给 `airing-cal-sync` 的内部路由。

Analytics 环境变量目前是保留项，代码不会注入 GA4、Clarity、Yandex Metrica 或 Baidu Tongji 脚本；这避免在没有官方片段验证前输出假的占位注释。

## 致谢

- [bangumi/api](https://github.com/bangumi/api) 提供 API
- [GeeKaven/BangumiTV](https://github.com/GeeKaven/BangumiTV) 原始项目
