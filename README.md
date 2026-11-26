# AiringCal

> Bangumi 追番进度静态页 + Cloudflare 读 Worker + GitHub Actions portable 写路径（ADR 0003）。

**给 AI：** 先读 [`START_HERE_FOR_AI.md`](START_HERE_FOR_AI.md) 与 [`docs/README.md`](docs/README.md)（结构、部署、读/写路径）。**For agents:** same files — do not use archived Workers/VPS/QingLong docs as production truth.

## Current production and v3 delivery

**Current production remains the legacy v2 read path.** **Development live
acceptance passed 2026-11-08 and was re-verified 2026-11-26** (single private
bucket `airingcal-development`, canonical Worker `airingcal-development`,
worker-origin public interface with `checkpoints/` denied, CF + EdgeOne
readers, live Full Sync generation 6) — evidence in
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
| Storage target | One **private** R2 Bucket per environment; the v3 Worker is the public origin (Worker custom domain optional), serving only the allowlisted object interface; `checkpoints/**` denied; GET/HEAD-only, ETag/304 and pointer-ref allowlists enforced in the shared read gateway |
| Image CDN | Optional independent base URL; off by default |
| Next gate | Issue [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73) — Production Full Clean Deploy (apply executor wired; awaiting Owner Apply + first-sync dispatch); then `dev` → `main` release integration |

**Start here:** [Deployment guide](docs/DEPLOYMENT.md) → [Current v3 state and required sequencing](docs/v3/current-state.md) → [Docs index](docs/README.md). Historical Workers/VPS/QingLong instructions are under [docs/archive](docs/archive/README.md).

## Install (two tokens)

```bash
pnpm install
pnpm run setup
```

`pnpm run setup` is the canonical installation experience: it opens an
arrow-key menu (Install or Update / Validate API Credentials / Doctor / Exit),
guides you through the two masked credentials with inline permission checks,
discovers the Cloudflare account, workers.dev subdomain and Bangumi identity,
derives `USERS_JSON`, asks about an optional Worker Custom Domain, shows a
concise Configuration Review (edit any section before installing), provisions
through the same engine as the headless CLI, asks separately for the First Full
Sync, runs the applicable live verifier and writes a sanitized inventory to
`.airingcal/`. Cloudflare is the only provider in a normal installation
(EdgeOne is optional legacy delivery, never implied). Terminal styling follows
your theme (`AIRINGCAL_THEME=auto|dark|light`), honors `NO_COLOR`, and prints no
ANSI in non-TTY/headless runs.
**No manual dotenv editing is required** — Account ID, Primary User ID and
`USERS_JSON` are discovered/derived in-memory. Headless dotenv configuration
(`node scripts/deploy-env.mjs ...`, `pnpm run setup --headless`) remains an
advanced alternative for automation.

Note: `pnpm setup` (without `run`) is pnpm's own built-in shell-configuration
command and does NOT start the wizard — always use `pnpm run setup`.

Production is the default environment, needs no Zone ID in Worker mode, and
keeps the same gates: nothing is applied before the interactive confirmation,
and the first sync opens only a temporary, self-closing gate. See the
[deployment guide](docs/DEPLOYMENT.md) for the advanced/headless path.

## Dev

```bash
pnpm install
pnpm dev                    # web-worker local
pnpm -F @airing-cal/node-jobs test && pnpm -F @airing-cal/node-jobs build
```
