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

CI / deploy 见 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)（`validate` matrix → `deploy_web_worker`）。构建 commit / 时间与 `GET /api/version` 的 JSON 契约见 [docs/reference/web-worker-public-api.md](../../docs/reference/web-worker-public-api.md)。

## 源码布局

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 路由入口、静态 widget |
| `src/read-api.ts` | 只读 JSON + health + R2 snapshot 读路径 |
| `src/thumb-gen.ts` | `POST /api/thumb-gen`（Bearer） |
| `src/thumb-backfill-scheduled.ts` | D1 扫描 helper（仅测试/运维；thumb 由 Builder 离线生成，运维可带 Bearer 调 `POST /api/thumb-gen`） |
| `src/version.ts` | `/api/version` 载荷 |
| `src/read-mode.ts` | `AIRINGCAL_READ_MODE=v3-release`（#147 C7）：从公共 Release 提供同一读 surface；默认 legacy 不变 |

### Thumb deploy（AC-2）

1. `pnpm exec wrangler secret put THUMB_GEN_BEARER --name airing-cal-frontend`
2. 确认 `wrangler.toml` 含 `[images] binding = "IMAGES"`（**无** `[triggers]` cron）
3. node-jobs：`AIRINGCAL_THUMB_GEN_URL` + `AIRINGCAL_THUMB_GEN_BEARER`（同 secret）
4. 验证：`curl -sf -o /dev/null -w '%{http_code}' -X POST https://<site>/api/thumb-gen` → **401**
5. sync 后 node-jobs batch POST，或运维带 Bearer 手动 POST；列表应请求 `/image/<hash>/thumb`（缺失返回 404，不回退 302 到不存在的 CDN 对象）

`THUMB_SPEC v2`：320×427 cover WebP q78 → `images/{hash}/thumb.v2.webp`（读 `/thumb` 回退 v1）。边缘缓存见 [performance-edge-cache](../../docs/runbook/performance-edge-cache.md)。
