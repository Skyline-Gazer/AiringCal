# `@airing-cal/web-worker`

Phase 0 唯一公网 Worker：`airing-cal-frontend`（页面、`/src/*`、只读 `/api/*`、`/image/:hash`）。

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
| `src/version.ts` | `/api/version` 载荷 |
