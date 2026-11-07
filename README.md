# AiringCal

> Bangumi 追番进度静态页 + Cloudflare 读 Worker + GitHub Actions portable 写路径（ADR 0003）。

**给 AI：** 先读 [`START_HERE_FOR_AI.md`](START_HERE_FOR_AI.md) 与 [`docs/README.md`](docs/README.md)（结构、部署、读/写路径）。**For agents:** same files — do not use archived Workers/VPS/QingLong docs as production truth.

## Current production and v3 delivery

**Current production remains the legacy v2 read path.** PR [#164](https://github.com/Skyline-Gazer/AiringCal/pull/164) is merged into `dev`; the next step is **Development** live acceptance, **not** production cutover. The GitHub Actions portable Writer is the approved v3-only writer and the Production scheduled job stays disabled.

| Surface | Current / approved state |
| --- | --- |
| Read in Production | Existing `apps/web-worker` Worker `airing-cal-frontend` in v2 mode until explicit GO/NO-GO |
| Read in v3 Development | Cloudflare Worker and EdgeOne Makers overseas readers consuming one R2 Release |
| Write in v3 | GitHub Actions `portable-writer.yml` → `apps/node-jobs` Portable Builder (sole Writer); no QingLong/CNB/Docker |
| Storage target | One R2 Bucket per environment, public Release/images via R2 custom domain, `checkpoints/` denied publicly |
| Image CDN | Optional independent base URL; off by default |
| Next gate | Issue [#147](https://github.com/Skyline-Gazer/AiringCal/issues/147) — Development Live Acceptance; [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73) is later Production cutover |

**Start here:** [Current v3 state and required sequencing](docs/v3/current-state.md) → [Docs index](docs/README.md) → [Development cutover runbook](docs/v3/reader-delivery-cutover.md). Historical Workers/VPS/QingLong instructions are under [docs/archive](docs/archive/README.md).

## Dev

```bash
pnpm install
pnpm dev                    # web-worker local
pnpm -F @airing-cal/node-jobs test && pnpm -F @airing-cal/node-jobs build
```
