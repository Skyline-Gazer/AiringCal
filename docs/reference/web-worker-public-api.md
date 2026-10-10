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

## 其他公开路由

完整路由表与产品说明见仓库根 [README.md](../../README.md)「外部访问入口」。数据类端点（`/api/collections`、`/api/calendar`、`/api/health` 等）行为见 Phase 0 计划 [docs/plans/phase-0-web-worker.md](../plans/phase-0-web-worker.md)。
