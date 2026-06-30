# AiringCal

> 在静态页面中渲染你的 Bangumi 追番进度

AiringCal 现在是 Cloudflare Workers monorepo：公开页面、只读数据、定时同步、媒体补全分别部署，避免把公开请求、KV/R2 读取、bgm.tv 抓取和图片下载挤在同一个 Worker 调用预算里。

## Architecture

| Unit | Package | Responsibility |
|------|---------|----------------|
| `frontend-worker` | `apps/frontend-worker` | 唯一公开入口，服务 `/`、`/cache`、widget JS/CSS、BFF JSON route 和 `/image/:hash` 代理 |
| `read-worker` | `apps/read-worker` | 内部 service binding 只读 API，只从 KV/R2 读取 snapshot、配置、健康状态、缓存统计和图片 |
| `sync-worker` | `apps/sync-worker` | Cloudflare native scheduled event，每 4 小时抓取 collection/calendar，写 snapshot，并把媒体任务送入 Queue |
| `media-worker` | `apps/media-worker` | Queue consumer，下载 common/large 图片，写入 R2，更新 image/subject meta KV |

Shared packages:

| Package | Responsibility |
|---------|----------------|
| `@airing-cal/bgm-api` | bgm.tv client、OpenAPI-pinned types、token/API helpers |
| `@airing-cal/domain` | snapshot merge、image ref、subject meta、queue/data contracts |
| `@airing-cal/storage` | KV/R2 adapters and key builders |
| `@airing-cal/widget` | HTML shell, footer, cache page, widget JS/CSS assets |
| `@airing-cal/worker-common` | public errors, safe headers, sanitization, deploy/docs guard tests |

## Public Surface

All browser traffic goes through `frontend-worker`.

| Route | Purpose |
|-------|---------|
| `/` | Public widget page with shared footer and build link |
| `/cache` | Public, sanitized cache statistics page |
| `/src/bangumi.js` | Widget script |
| `/src/bangumi.css` | Widget styles |
| `/api/collections?type=watching` | Collection snapshot through `READ_WORKER` |
| `/api/calendar` | Calendar snapshot through `READ_WORKER` |
| `/api/config?key=nsfw` | Public config through `READ_WORKER` |
| `/api/health` | Read health through `READ_WORKER` |
| `/api/cache` | Sanitized cache JSON through `READ_WORKER` |
| `/image/:hash` | R2 image read through `READ_WORKER` |

Production sync is a Worker scheduled event configured in `apps/sync-worker/wrangler.toml`:

```toml
[triggers]
crons = ["0 */4 * * *"]
```

There is no public HTTP sync trigger in the target architecture.

## Data Contracts

Public collection and calendar entries use the new image shape:

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

Use `images.common` for the normal card cover and `images.large` when a larger cached source is needed.

The image hash is `sha256(downloaded_image_bytes)` in lowercase hex. The R2 key is always `images/{hash}/original`.

KV keys written by the new workers:

| Key | Writer | Purpose |
|-----|--------|---------|
| `snapshot:collections:{type}` | `sync-worker` | Per collection type public snapshot |
| `snapshot:calendar` | `sync-worker` | Calendar snapshot |
| `snapshot:summary` | `sync-worker` | Count summary |
| `sync:meta` | `sync-worker` | Last sync metadata |
| `subject:meta:{subject_id}` | `media-worker` | Subject detail and NSFW decision |
| `image:status:{subject_id}` | `media-worker` | Per-subject common/large cache state |
| `image:index:{hash}` | `media-worker` | Hash to subject/source metadata |

Subject detail `404` is cached conservatively as:

```json
{
  "exists": false,
  "nsfw": true,
  "reason": "not_found_or_restricted"
}
```

## Deployment

Routine deployment uses checked-in app configs only:

| App config | Worker |
|------------|--------|
| `apps/frontend-worker/wrangler.toml` | `airing-cal-frontend` |
| `apps/read-worker/wrangler.toml` | `airing-cal-read` |
| `apps/sync-worker/wrangler.toml` | `airing-cal-sync` |
| `apps/media-worker/wrangler.toml` | `airing-cal-media` |

Provision Cloudflare resources outside the normal deploy path, then put the real resource identifiers in the app configs. The GitHub Actions workflow does not create KV/R2 resources, list namespaces, rewrite configs, upload secrets in a loop, or mutate schedules.

Minimal configuration:

GitHub only needs Cloudflare deploy credentials:

| Name | Used by | Purpose |
|------|---------|---------|
| `CF_API_TOKEN` | workflow | Cloudflare deploy token |
| `CF_ACCOUNT_ID` | workflow | Cloudflare account id |

Create `CF_API_TOKEN` from Cloudflare Dashboard -> My Profile -> API Tokens -> Create custom token.
Use these token permissions for the current workflow:

| Scope | Permission | Why |
|-------|------------|-----|
| Account | Workers Scripts: Edit | Deploy the four Worker scripts |
| Account | Workers KV Storage: Edit | Attach the existing `airing-cal-kv` namespace to Workers |
| Account | Workers R2 Storage: Edit | Attach the existing `airing-cal-images` bucket to Workers |
| Account | Workers Queues: Edit | Attach the `airing-cal-media` producer/consumer queue bindings |
| Account | Account Settings: Read | Let Wrangler resolve account metadata |
| User | User Details: Read | Let Wrangler identify the API token user |

The current workflow does not create resources, upload runtime secrets, or manage routes. Do not add broader permissions unless you also change the workflow:

| Permission | Needed now? |
|------------|-------------|
| Zone - Workers Routes: Edit | No, unless you add route/custom-domain deployment to `wrangler.toml` |
| Account - Workers KV Storage: Create-only provisioning scripts | No, resources are provisioned outside routine deploy |
| Account - Workers R2 Storage bucket creation | No, resources are provisioned outside routine deploy |
| Secret upload permissions through CI | No, bgm.tv runtime secrets are set in Cloudflare Dashboard |

Set bgm.tv runtime values only on `airing-cal-sync` in the Cloudflare dashboard:

| Name | Config | Purpose |
|------|--------|---------|
| `BANGUMI_TOKEN` | Secret | bgm.tv access token |
| `BANGUMI_USERS` | Variable | Comma-separated bgm usernames |
| `BANGUMI_PRIMARY_USER` | Variable | Optional primary user for primary-mode sync |

Everything else is checked in:

- `PUBLIC_REPOSITORY_URL` lives in `apps/frontend-worker/wrangler.toml`.
- `SYNC_MODE = "merge"` lives in `apps/sync-worker/wrangler.toml`.
- `keep_vars = true` is set in each Worker config so deploys do not wipe dashboard-managed runtime variables.

## Local Development

Install and verify:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build:check
```

Run one Worker at a time:

```bash
pnpm -F @airing-cal/frontend-worker cf:types
pnpm -F @airing-cal/frontend-worker build:check
```

Use each app's `wrangler.toml` as the source of truth for local and deployed bindings. `wrangler types worker-configuration.d.ts --check --config wrangler.toml` is part of every app build check.

## CI

`.github/workflows/deploy.yml` runs:

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build:check`
5. Deploy `read-worker`
6. Deploy `media-worker`
7. Deploy `sync-worker`
8. Deploy `frontend-worker`

The deploy order ensures internal read/media/sync units exist before the public frontend binding is updated.

## Cache and NSFW Behavior

`/cache` is public and secret-safe. It reports aggregate image/cache state only; it does not expose access tokens, raw authenticated upstream bodies, or unsanitized upstream errors.

`media-worker` fetches subject detail for enrichment. Restricted or missing subjects are treated as NSFW by default so they are not accidentally shown as safe.

## Widget

The widget source of truth is `packages/widget`. Public pages share the same footer renderer. When a commit SHA and repository URL are available, the footer links to the exact build commit; otherwise it renders `Build unknown`.

The browser widget reads `images.common.uri` for covers and falls back to an inline placeholder when no cached image is available.

## Thanks

- [bangumi/api](https://github.com/bangumi/api) 提供 API
- [GeeKaven/BangumiTV](https://github.com/GeeKaven/BangumiTV) 原始项目
