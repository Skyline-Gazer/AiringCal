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
| `/api/collections?type=watching` | 通过 `READ_WORKER` 读取 collection snapshot |
| `/api/calendar` | 通过 `READ_WORKER` 读取 calendar snapshot |
| `/api/config?key=nsfw` | 通过 `READ_WORKER` 读取公开配置 |
| `/api/health` | 通过 `READ_WORKER` 读取健康状态 |
| `/api/cache` | 通过 `READ_WORKER` 读取脱敏缓存 JSON |
| `/image/:hash` | 通过 `READ_WORKER` 读取 R2 图片 |

`airing-cal-sync` 没有公开同步 URL；生产同步由 Cloudflare Cron 触发：

```toml
[triggers]
crons = ["0 */4 * * *"]
```

## Cloudflare 资源

当前约定的 Cloudflare 资源名：

| 类型 | 名称 |
|------|------|
| KV namespace title | `airing-cal-kv` |
| R2 bucket | `airing-cal-images` |
| Queue | `airing-cal-media` |
| Service binding | `READ_WORKER -> airing-cal-read` |

当前绑定名：

| Worker | Binding |
|--------|---------|
| `airing-cal-frontend` | `READ_WORKER` |
| `airing-cal-read` | `AIRING_CAL_KV`, `AIRING_CAL_R2` |
| `airing-cal-sync` | `AIRING_CAL_KV`, `MEDIA_QUEUE` |
| `airing-cal-media` | `AIRING_CAL_KV`, `AIRING_CAL_R2` |

常规 CI 部署不会创建 KV/R2/Queue，不会上传运行时 secret，不会改写 `wrangler.toml`，也不会调用 Cloudflare REST API 修改 cron schedule。请先在 Cloudflare 侧创建资源，再部署。

KV 比较特殊：`wrangler.toml` 里的 `kv_namespaces.id` 不是 namespace title，而是 Cloudflare 生成的 namespace ID。创建 `airing-cal-kv` 后，把实际 ID 填到这 3 个文件中：

- `apps/read-worker/wrangler.toml`
- `apps/sync-worker/wrangler.toml`
- `apps/media-worker/wrangler.toml`

需要替换的占位符是：

```toml
id = "<AIRING_CAL_KV_NAMESPACE_ID>"
```

## 最小配置

### GitHub Actions Secrets

GitHub 只需要两个 secret，用于部署 Cloudflare：

| 名称 | 说明 |
|------|------|
| `CF_API_TOKEN` | Cloudflare API Token |
| `CF_ACCOUNT_ID` | Cloudflare Account ID |

`CF_API_TOKEN` 创建位置：

Cloudflare Dashboard -> My Profile -> API Tokens -> Create custom token。

当前 workflow 需要的 token 权限：

| 范围 | 权限 | 用途 |
|------|------|------|
| Account | `Workers Scripts: Edit` | 部署 4 个 Worker script |
| Account | `Workers KV Storage: Edit` | 部署带 `airing-cal-kv` 绑定的 Worker |
| Account | `Workers R2 Storage: Edit` | 部署带 `airing-cal-images` 绑定的 Worker |
| Account | `Workers Queues: Edit` | 部署 Queue producer/consumer binding |
| Account | `Account Settings: Read` | 让 Wrangler 解析账户信息 |
| User | `User Details: Read` | 让 Wrangler 识别 API token 用户 |

当前 workflow 不需要这些权限：

| 权限 | 是否需要 |
|------|----------|
| Zone - Workers Routes: Edit | 不需要，除非以后在 `wrangler.toml` 中加入 route/custom domain 部署 |
| 创建 KV namespace / R2 bucket / Queue 的权限 | 不需要，资源在常规部署外预先创建 |
| 通过 CI 上传 Worker secrets | 不需要，运行时 secret 在 Cloudflare Dashboard 配置 |

### Cloudflare Worker 变量

只需要在 `airing-cal-sync` 配 bgm.tv 运行时信息：

| 名称 | 类型 | 说明 |
|------|------|------|
| `BANGUMI_TOKEN` | Secret | bgm.tv access token |
| `BANGUMI_USERS` | Variable | bgm 用户名，多个用户用英文逗号分隔 |

不用在 `airing-cal-media` 配 `BANGUMI_TOKEN`；media-worker 只下载图片和读取可选 subject detail，不需要 access token。

其余配置已经写在 repo：

- `PUBLIC_REPOSITORY_URL` 在 `apps/frontend-worker/wrangler.toml`
- `SYNC_MODE = "merge"` 在 `apps/sync-worker/wrangler.toml`
- 4 个 Worker 都设置了 `keep_vars = true`，CI 部署不会擦掉 Dashboard 里的运行时变量

可选配置：

| 名称 | 配置位置 | 说明 |
|------|----------|------|
| `NSFW_SHOW=false` | `airing-cal-read` Variable | 不展示 R18 内容；不设置时默认展示 |

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
  }
}
```

规则：

- 卡片封面默认使用 `images.common.uri`
- 需要大图时使用 `images.large`
- 图片 hash 是 `sha256(downloaded_image_bytes)` 的小写 hex
- R2 key 固定为 `images/{hash}/original`

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
5. 部署 `airing-cal-read`
6. 部署 `airing-cal-media`
7. 部署 `airing-cal-sync`
8. 部署 `airing-cal-frontend`

这个顺序保证内部 read/media/sync Worker 先更新，最后再更新公开入口 frontend Worker。

## Cache 与 NSFW

`/cache` 是公开且脱敏的缓存状态页。它只展示聚合后的缓存状态，不暴露 access token、上游认证响应体或未清理的错误信息。

`airing-cal-media` 会抓取 subject detail 做 NSFW enrichment。受限或不存在的 subject 会按 NSFW 处理，避免误展示为安全内容。

## Widget

Widget 的唯一来源是 `packages/widget`。公开 HTML 页面复用同一个 footer renderer。

如果部署环境提供 commit SHA 和 repository URL，footer 会链接到对应 commit；否则显示 `Build unknown`。

浏览器 widget 使用 `images.common.uri` 渲染封面。没有缓存图片时，使用内联 placeholder。

## 致谢

- [bangumi/api](https://github.com/bangumi/api) 提供 API
- [GeeKaven/BangumiTV](https://github.com/GeeKaven/BangumiTV) 原始项目
