# `@airing-cal/web-worker`

Phase 0 唯一公网 Worker：`airing-cal-frontend`（页面、`/src/*`、只读 `/api/*`、`/image/:hash`、`/image/:hash/thumb`）。

Cover thumb pipeline：`POST /api/thumb-gen`（Wrangler secret `THUMB_GEN_BEARER` + `[images]` binding `IMAGES`）。契约见 [web-worker-public-api.md](../../docs/reference/web-worker-public-api.md)。

## 本地

```bash
pnpm install
pnpm -F @airing-cal/web-worker dev
```

## 测试

```bash
pnpm -F @airing-cal/web-worker test
```

## 部署与构建元数据

CI 见 [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) 的 `deploy_web_worker`。构建 commit / 时间与 `GET /api/version` 的 JSON 契约见 [docs/reference/web-worker-public-api.md](../../docs/reference/web-worker-public-api.md)。

## 源码布局

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 路由入口、静态 widget |
| `src/read-api.ts` | 只读 JSON + health + R2 snapshot 读路径 |
| `src/thumb-gen.ts` | `POST /api/thumb-gen`（Bearer） |
| `src/thumb-backfill-scheduled.ts` | Cron 补偿缺失 `thumb.v1.webp`（`15 * * * *` UTC） |
| `src/version.ts` | `/api/version` 载荷 |

### Thumb deploy（AC-2）

1. `pnpm exec wrangler secret put THUMB_GEN_BEARER --name airing-cal-frontend`
2. 确认 `wrangler.toml` 含 `[images] binding = "IMAGES"` 与 `[triggers] crons`
3. QingLong：`AIRINGCAL_THUMB_GEN_URL` + `AIRINGCAL_THUMB_GEN_BEARER`（同 secret）
4. 验证：`curl -sf -o /dev/null -w '%{http_code}' -X POST https://<site>/api/thumb-gen` → **401**
5. 带 Bearer batch POST 或等 cron；列表应请求 `/image/<hash>/thumb`

`THUMB_SPEC v2`：320×427 cover WebP q78 → `images/{hash}/thumb.v2.webp`（读 `/thumb` 回退 v1）。联调：[QINGLONG thumb pipeline](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/plans/airingcal-thumb-pipeline.md)。边缘缓存见 [performance-edge-cache](../../docs/runbook/performance-edge-cache.md)。
