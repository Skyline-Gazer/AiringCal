# AiringCal

> Bangumi 追番进度静态页 + Cloudflare 读 Worker + 青龙写路径。

**给 AI：** 先读 [`START_HERE_FOR_AI.md`](START_HERE_FOR_AI.md) 与 [`docs/README.md`](docs/README.md)（结构、部署、读/写路径）。**For agents:** same files — do not use archived Workers/VPS docs as production truth.

## Production (summary)

| 面 | 组件 |
| --- | --- |
| **读** | `apps/web-worker` → Worker `airing-cal-frontend` |
| **写** | QingLong → CI **`qinglong-bundle`** ← `apps/node-jobs` |

历史四 Worker / VPS 见 [`docs/archive/README.md`](docs/archive/README.md)。

## Dev

```bash
pnpm install
pnpm dev                    # web-worker local
pnpm -F @airing-cal/node-jobs test && pnpm -F @airing-cal/node-jobs build
```

## QingLong

面板步骤：[QINGLONG operator-checklist](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/usage/airingcal-operator-checklist.md)
