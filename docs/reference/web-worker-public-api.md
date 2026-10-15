# web-worker 公开只读 API（Phase 0）

实现：`apps/web-worker/src/read-api.ts`（数据面）、`apps/web-worker/src/version.ts`（构建元数据）。

生产 Wrangler 服务名仍为 **`airing-cal-frontend`**。除下文单独说明的路由外，错误体与 `Cache-Control` 行为与合并前 read-worker 一致。

## `GET /api/version`

用于确认线上 Worker 是否已部署到预期 commit，以及 `@airing-cal/web-worker` 包版本。不访问 D1/KV/R2，不暴露密钥。

| 项 | 值 |
|----|-----|
| 方法 | `GET` |
| 认证 | 无 |
| 成功 HTTP | `200` |
| `Cache-Control` | `public, max-age=60` |

### 响应 JSON

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | 固定为 `true` |
| `service` | `"airing-cal-frontend"` | 对外服务名 |
| `app` | `"web-worker"` | monorepo 应用 id |
| `package.name` | string | npm 包名，当前 `@airing-cal/web-worker` |
| `package.version` | string | 与 `apps/web-worker/package.json` 一致（SemVer） |
| `git.commit` | string \| null | 40 位十六进制 SHA（小写）；Wrangler `[vars]` 未提供或格式无效时为 `null` |
| `git.commit_short` | string \| null | `commit` 前 7 位；`commit` 为 `null` 时为 `null` |
| `git.repository` | string \| null | 仓库 URL（如 `https://github.com/Skyline-Gazer/AiringCal`） |
| `build.built_at` | string \| null | ISO 8601 时间戳；CI 从 `github.event.head_commit.timestamp` 注入，本地未设置时为 `null` |

示例（字段齐全时）：

```json
{
  "ok": true,
  "service": "airing-cal-frontend",
  "app": "web-worker",
  "package": {
    "name": "@airing-cal/web-worker",
    "version": "1.1.0"
  },
  "git": {
    "commit": "4c540bcd9fd494563cf4503338b5efc6db28e3af",
    "commit_short": "4c540bc",
    "repository": "https://github.com/Skyline-Gazer/AiringCal"
  },
  "build": {
    "built_at": "2026-10-10T10:20:55Z"
  }
}
```

### 构建时 Worker 变量

由 `scripts/materialize-wrangler-config.mjs` 在存在对应进程环境变量时写入 materialized `wrangler.toml` 的 `[vars]`（非 secret）：

| 变量 | 设置方 | 说明 |
|------|--------|------|
| `BANGUMI_GIT_COMMIT_SHA` | GitHub Actions `deploy_web_worker`：`needs.resolve_ref.outputs.sha` | 必须与 footer 链接使用的 commit 一致 |
| `BANGUMI_GIT_REPOSITORY_URL` | CI：`https://github.com/${{ github.repository }}` | 可选；缺省则 `git.repository` 为 `null` |
| `BANGUMI_BUILD_TIME` | CI：`github.event.head_commit.timestamp` | 可选；`workflow_dispatch` 无 push commit 时可能为空 |

本地 `wrangler dev` / 未注入上述变量时，端点仍返回 `200`，`git.*` 与 `build.built_at` 多为 `null`，`package.version` 仍来自代码内常量。

手动部署示例：

```bash
export BANGUMI_GIT_COMMIT_SHA="$(git rev-parse HEAD)"
export BANGUMI_GIT_REPOSITORY_URL="https://github.com/Skyline-Gazer/AiringCal"
export BANGUMI_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/materialize-wrangler-config.mjs apps/web-worker/wrangler.toml /tmp/wrangler-web-worker.toml
pnpm exec wrangler deploy --config /tmp/wrangler-web-worker.toml
```

### 运维核对

```bash
curl -sS 'https://<你的域名>/api/version' | jq '.git.commit_short, .package.version, .build.built_at'
```

与 GitHub Actions 本次 `resolve_ref` 输出的 SHA 前 7 位、`apps/web-worker/package.json` 的 `version` 对照即可。

## `GET /image/:hash/thumb`

Pre-materialized cover thumb only (`images/{hash}/thumb.v2.webp` preferred, `thumb.v1.webp` fallback). No on-the-fly transform.

| 项 | 值 |
|----|-----|
| 方法 | `GET` |
| 认证 | 无 |
| 成功 HTTP | `200`，`Content-Type: image/webp` |
| 缺失 | `404` |
| `Cache-Control` | `public, max-age=31536000, immutable`（与 `/image/:hash` 一致） |

`GET /image/:hash` 仍返回 `images/{hash}/original`，行为不变。

Widget 列表/日历封面：当 API 条目含 `images.large`（`hash` + `uri`）时，`<img>` 优先请求 `/image/{large.hash}/thumb`；加载失败（如 thumb 尚未生成，**404**）时依次回退 `images.large.uri`、再 `images.common.uri`。仅 `common` 时仍直接用 `common.uri`。

## `POST /api/thumb-gen`（Bearer，内部）

Materialize thumbs after sync writes large originals. Implemented in `apps/web-worker/src/thumb-gen.ts`.

| 项 | 值 |
|----|-----|
| 方法 | `POST` |
| 认证 | `Authorization: Bearer <THUMB_GEN_BEARER>`（Wrangler secret，timing-safe compare） |
| Body | `{ "large_hashes": ["<sha256>", ...] }`，最多 **50** 条/请求 |
| 成功 | **202** + `{ ok, results[], summary }`（`skipped` / `generated` / `missing_original` / `error`） |
| 鉴权失败 | **401** |

Per hash: `HeadObject` thumb key → skip；否则 R2 get original → Cloudflare **Images** binding transform → `PutObject`.

**THUMB_SPEC v2（当前写入）：** 320×427 `cover` WebP quality 78 → `images/{hash}/thumb.v2.webp`。读路径 `/thumb` 优先 v2，否则 v1（420×560 q85）。见 `thumb-materialize.ts` 与 [performance-edge-cache runbook](../runbook/performance-edge-cache.md)。

### Cron backfill（AC-2-05，无 HTTP）

| 项 | 值 |
|----|-----|
| 调度 | `15 * * * *` UTC（`wrangler.toml` `[triggers].crons`） |
| 逻辑 | D1 `subject_media` 扫描 `r2_image_large_key`，缺 thumb 则 materialize（批大小默认 30，`THUMB_BACKFILL_BATCH` 可选，上限 50） |
| 实现 | `apps/web-worker/src/thumb-backfill-scheduled.ts` |

## 其他公开路由

完整路由表与产品说明见仓库根 [README.md](../../README.md)「外部访问入口」。数据类端点（`/api/collections`、`/api/calendar`、`/api/health` 等）行为见 Phase 0 计划 [docs/plans/phase-0-web-worker.md](../plans/phase-0-web-worker.md)。
