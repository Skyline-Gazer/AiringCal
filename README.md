# AiringCal

> Bangumi 追番进度静态页 + Cloudflare 读 Worker + GitHub Actions portable 写路径（ADR 0003）。

**给 AI：** 先读 [`START_HERE_FOR_AI.md`](START_HERE_FOR_AI.md) 与 [`docs/README.md`](docs/README.md)（结构、部署、读/写路径）。**For agents:** same files — do not use archived Workers/VPS/QingLong docs as production truth.

## Production (summary)

| 面 | 组件 |
| --- | --- |
| **读** | `apps/web-worker` → Worker `airing-cal-frontend`（`AIRINGCAL_PUBLIC_BASE_URL` 时可 302 出图） |
| **写** | GitHub Actions **`portable-writer`** → `apps/node-jobs` portable bundle → S3（R2 day one） |

Ops: [`docs/v3/gha-portable-writer.md`](docs/v3/gha-portable-writer.md). 历史四 Worker / VPS / 青龙写路径见 [`docs/archive/README.md`](docs/archive/README.md).

## Dev

```bash
pnpm install
pnpm dev                    # web-worker local
pnpm -F @airing-cal/node-jobs test && pnpm -F @airing-cal/node-jobs build
```
