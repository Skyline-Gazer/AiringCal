# AiringCal

> Bangumi 追番进度静态页 + Cloudflare 读 Worker + GitHub Actions portable 写路径（ADR 0003）。

**给 AI：** 先读 [`START_HERE_FOR_AI.md`](START_HERE_FOR_AI.md) 与 [`docs/README.md`](docs/README.md)（结构、部署、读/写路径）。**For agents:** same files — do not use archived Workers/VPS/QingLong docs as production truth.

## Current production and v3 delivery

**Current production remains the legacy v2 read path.** **Development live
acceptance passed 2026-11-08** (single bucket `airingcal-development`, R2 custom
domain, WAF `checkpoints/` isolation, CF + EdgeOne readers, DNS cutover, live
Full Sync generation 4) — evidence in
[`docs/v3/development-live-acceptance.md`](docs/v3/development-live-acceptance.md).
The remaining gates are the Owner-approved **Production clean bootstrap**
(one-shot Full Sync, no v2 copy) and the `dev` → `main` release integration. The
GitHub Actions portable Writer stays the only v3 writer and the Production
scheduled job remains disabled until the Owner flips the gates.

| Surface | Current / approved state |
| --- | --- |
| Read in Production | Existing `apps/web-worker` Worker `airing-cal-frontend` in v2 mode until explicit GO/NO-GO |
| Read in v3 Development | Cloudflare Worker and EdgeOne Makers overseas readers consuming one R2 Release — **live, accepted 2026-11-08** |
| Write in v3 | GitHub Actions `portable-writer.yml` → `apps/node-jobs` Portable Builder (sole Writer); no QingLong/CNB/Docker |
| Storage target | One R2 Bucket per environment, public Release/images via R2 custom domain, `checkpoints/` denied publicly; Viewer routes additionally enforce GET/HEAD-only, ETag/304 and pointer-ref allowlists in the shared read gateway |
| Image CDN | Optional independent base URL; off by default |
| Next gate | Issue [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73) — Production Full Clean Deploy (apply executor wired; awaiting Owner Apply + first-sync dispatch); then `dev` → `main` release integration |

**Start here:** [Deployment guide](docs/DEPLOYMENT.md) → [Current v3 state and required sequencing](docs/v3/current-state.md) → [Docs index](docs/README.md). Historical Workers/VPS/QingLong instructions are under [docs/archive](docs/archive/README.md).

## Dev

```bash
pnpm install
pnpm dev                    # web-worker local
pnpm -F @airing-cal/node-jobs test && pnpm -F @airing-cal/node-jobs build
```
