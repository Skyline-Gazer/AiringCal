# AiringCal deployment guide (authoritative)

**One entry point:** `scripts/deploy-env.mjs`. One guide answers "how do I deploy
AiringCal". Per-environment evidence lives in
[`v3/development-live-acceptance.md`](v3/development-live-acceptance.md) and
[`v3/production-acceptance.md`](v3/production-acceptance.md); this file is the
procedure, those files are the receipts.

Delivery topology (AGENTS.md): GitHub is the development origin; the GitHub
Actions one-shot Portable Builder is the approved target writer; Cloudflare and
EdgeOne (and future Netlify/Vercel) are stateless readers. There is no CNB,
QingLong or Docker/Compose delivery.

## Model

Each environment owns **one R2 bucket** holding `public/`, `snapshots/`,
`images/` and the private `checkpoints/` prefix. The read plane is a single
Cloudflare Worker (`apps/v3-read-worker`) that bundles the Reader/Widget static
assets and serves the allowlisted Viewer routes (`/api/config`, `/api/version`,
`/api/health`, `/api/collections`, `/api/calendar`, `/api/cache`,
`/image/:hash[/thumb]`) **plus the public object interface**
(`/public/current-release.json`, legacy `/public/manifest.json`,
`/snapshots/v1/{gen}-{hash}.json`, `/public/manifests/{gen}-{hash}.json`,
`/images/{hash}/original|thumb.v1.webp|thumb.v2.webp`) over one **private** R2
binding. By default the Worker origin *is* the public surface: images are
streamed with sniffed `Content-Type` and immutable cache, every other key
(including `checkpoints/**`, encoded and traversal variants) is 404 before any
object read, and cross-origin access is governed by the exact-origin allowlist
`AIRINGCAL_CORS_ORIGINS`. Publishing raw bucket URLs (custom domain + host
WAF/cache/CORS, `bucket-domain` mode) is a legacy opt-in selected only by
setting `AIRINGCAL_PUBLIC_BASE_URL` to a non-Worker `https://` origin; the
live `airingcal.223.im` topology runs in that mode. The Worker never exposes
checkpoints (no listing, no key passthrough, GET/HEAD only, pointer refs
prefix-allowlisted).
EdgeOne Makers mirrors the same static Reader for the overseas domain and
consumes the controlled interface above — it never fetches raw bucket keys.

Writes never happen in the read deploy: publishing is the GHA Portable Builder
(`.github/workflows/portable-writer.yml`), gated by `AIRINGCAL_WRITER_ENABLED`
(schedule) and, for the first production run only,
`AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED` (workflow_dispatch).

## Prerequisites

- Node 24 + `pnpm`, `wrangler` and `gh` CLI authenticated (`gh auth status`).
- Cloudflare account: R2 + zone (`AIRINGCAL_ZONE_ID`) + account id
  (32-char hex). API token scopes: `R2:Read`, `R2:Edit`, `R2:Manage`,
  `Zone:Read`, `Zone:DNS:Edit`, `Zone:WAF:Edit`, `Workers:Write`,
  `Members:Read` (apply probes them and aborts on gaps).
- EdgeOne API token (only when `target` includes `edgeone`).
- Bangumi token for the writer.
- DNS ownership of the public base domain (the cutover step creates/points the
  `CNAME <sub>` record only when the Owner chose that hostname).

## Configuration

Per-environment dotenv files, never committed: `.env.staging`,
`.env.development`, `.env.production`. Production apply requires
`AIRINGCAL_DOTENV_PATH` to point at a file ending in `.env.production`, and
refuses to run if any `AIRINGCAL_STAGING_*`/`AIRINGCAL_DEVELOPMENT_*` value is
present in the process environment.

| Name | Kind | Meaning |
|---|---|---|
| `AIRINGCAL_ENV` | required selector | `staging` \| `development` \| `production` |
| `AIRINGCAL_DOTENV_PATH` | required for production | path to `.env.production` |
| `AIRINGCAL_PUBLIC_BASE_URL` | optional | **unset/`*.workers.dev` → `worker` mode** (Worker origin is the public surface, bucket fully private). A non-Worker `https://` origin selects legacy `bucket-domain` mode (custom domain + edge WAF/cache/CORS) and then must be a real R2 custom-domain URL — never a placeholder or `r2.dev`. |
| `AIRINGCAL_CORS_ORIGINS` | optional (worker mode) | comma-separated **exact** origins allowed cross-origin (`null` for file:// embeds); wildcards refused at config time; unset keeps OPTIONS at 405 and CORS an edge concern |
| `AIRINGCAL_ZONE_ID` | required for production; required in bucket-domain mode | Cloudflare zone (production preflight identity; domain/WAF rules otherwise) |
| `AIRINGCAL_CLOUDFLARE_API_TOKEN` | required secret | management token (S3 keys are derived from it) |
| `AIRINGCAL_CLOUDFLARE_ACCOUNT_ID` | required at apply | 32-char hex |
| `AIRINGCAL_BANGUMI_TOKEN` | required secret | writer token (synced to GitHub, never used by deploy reads) |
| `AIRINGCAL_EDGEONE_API_TOKEN` | required for target≠cloudflare | EdgeOne token |
| `AIRINGCAL_DEPLOY_TARGET` | optional | `cloudflare` \| `edgeone` \| `both` (default `both`) |
| `AIRINGCAL_PRIMARY_USER_ID` | optional | writer owner uid; needed for GitHub env sync |
| `AIRINGCAL_USERS_JSON` | optional (dev/staging writer config) | writer users payload |
| `AIRINGCAL_IMAGE_BASE_URL` | optional | sticky image base override; deploy clears it when unset |
| `AIRINGCAL_S3_ACCESS_KEY_ID` / `AIRINGCAL_S3_SECRET_ACCESS_KEY` / `AIRINGCAL_S3_REGION` / `AIRINGCAL_S3_ENDPOINT` | optional overrides | otherwise derived from the management token |
| `AIRINGCAL_PRODUCTION_WORKER_NAME` / `AIRINGCAL_EDGEONE_PROJECT` / `AIRINGCAL_EDGEONE_REGION` | optional | resource-name overrides |
| `AIRINGCAL_WRITER_ENABLED` | GitHub repo variable, not dotenv | schedule gate; deploy never flips it |
| `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED` | GitHub production env variable | first-sync gate; deploy pins it `false`, Owner sets `true` once |

Legacy `AIRINGCAL_STAGING_*` names still load through a compatibility alias map
and print a deprecation note; prefer the environment-neutral names above.

## Preflight (read-only, default)

```bash
AIRINGCAL_ENV=development node scripts/deploy-env.mjs --dry-run
AIRINGCAL_ENV=production AIRINGCAL_DOTENV_PATH=.env.production \
  node scripts/deploy-env.mjs --dry-run
```

Dry-run prints the full ordered step plan, resource names, derived values and
`refusedMutations: true`. It never touches Cloudflare, EdgeOne, GitHub or DNS.
Production dry-run additionally embeds `preflight-identity.gitSha` and refuses
to plan against staging/development resource names or environment values.

## Deploy — development (single bucket, live since 2026-11-07)

```bash
AIRINGCAL_ENV=development node scripts/deploy-env.mjs --apply \
  AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes   # in env or .env.development
```

Steps (each idempotent, abort fail-closed), **worker mode** (default):
token scope probe → S3 derive → writer freeze (workflow disable +
in-flight/lease check) → ensure bucket → disable r2.dev → GitHub
`development` env sync (writer gate pinned `false`; `PUBLIC_BASE_URL`
records the Worker origin) → deploy CF reader Worker + EdgeOne Makers →
image routing verify (real hashes streamed from the Worker) → CDN cache
validation → **isolation probe after deploys** (write with S3 `HEAD` proof,
anonymous GET/HEAD × plain/`%63`/`..%2f` variants against every deployed
reader origin, probe always deleted afterwards) → optional single-writer
smoke test. In legacy **bucket-domain** mode the edge steps run first
(attach custom domain → cache rules → CORS → WAF `checkpoints/` deny →
isolation probe before any copy) and `public/` + `checkpoints/` are copied
from the verified staging bucket.

Re-running after an interruption is safe: every step re-checks and no-ops;
an interrupted apply that left only the probe object behind is detected and
removed by `ensure-bucket` instead of poisoning the empty-bucket guard.

## Deploy — production (clean bootstrap, Owner-gated)

Production apply exists and is wired, but requires three explicit gates;
missing any one leaves it refusing with the plan printed and exit code 2:

```bash
AIRINGCAL_ENV=production AIRINGCAL_DOTENV_PATH=.env.production \
AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes \
AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes \
  node scripts/deploy-env.mjs --apply --i-am-sure-production
```

The production sequence is **copy-free**: it never reads or copies staging or
development data. `ensure-bucket` refuses a non-empty `airingcal-production`
bucket (the one exception being a provable leftover isolation-probe object,
verified against the known probe body and deleted before re-checking emptiness
— an interrupted apply is recovered, the guard is not weakened);
`checkpoints/` isolation is proven by the anonymous probe with write-`HEAD`
evidence and guaranteed cleanup — in worker mode after the readers deploy,
against every deployed reader origin, in bucket-domain mode before anything
is written; GitHub sync targets the `production` environment with
`AIRINGCAL_PRODUCTION_*` names and pins
`AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED=false`. Apply never enables the
writer and never dispatches the first sync — those are the Owner's separate
actions below.

## First data load (Owner dispatch, per environment)

1. Development/staging: the writer runs on schedule only when
   `AIRINGCAL_WRITER_ENABLED=true`; a manual run is a
   `workflow_dispatch` of `portable-writer.yml`.
2. Production first Full Sync: Owner sets
   `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED=true`, dispatches
   `portable-writer.yml` with `target=production`, `force_mode=full`, then
   clears the flag. Until it completes, the production reader answers
   `503 NO_RELEASE` by design.

## Verify

```bash
pnpm exec tsx scripts/reader-delivery-accept.mjs --env development --json
pnpm exec tsx scripts/reader-delivery-bench.mjs --env development --json
node scripts/v3-ship-verify.mjs --base https://airingcal.teijp.cn --json   # or --public-dir <mirror>
```

`v3-ship-verify.mjs` runs every read-surface probe automatically: static
index/Widget assets, pointer identity, API shape, method allowlist (405 +
`Allow`), conditional GET (`ETag`/304 on `/api/collections`, `/api/calendar`,
`/api/cache`), `checkpoints/**` isolation, and image delivery (original +
optional thumb). It is strictly read-only and exits non-zero on any failed
check. Remaining manual items: anonymous `GET/HEAD` on
`<public origin>/checkpoints/_isolation-probe.txt` must be 403 (bucket-domain
mode, WAF side) or 404 (worker mode, allowlist refusal) and is exercised
automatically by the deploy probe itself, and CORS allowlist behavior against
a non-allowlisted foreign origin.

## Update / rollback

- Config or code change: re-run the environment's `--apply` (idempotent);
  writer cadence is data-only and needs no deploy.
- Release rollback/roll-forward (pointer flip, CAS-safe):
  [`v3/cutover-rollback.md`](v3/cutover-rollback.md).
- Production acceptance checklist before Owner GO:
  [`v3/production-acceptance.md`](v3/production-acceptance.md).

## What deploy-env automates vs what stays Owner-run

| Automated by one apply command | Owner-run |
|---|---|
| bucket/domain/cache/CORS/WAF + isolation proof | DNS zone ownership, hostname choice |
| GitHub env vars/secrets sync (writer gates pinned off) | `AIRINGCAL_WRITER_ENABLED` flip |
| CF Worker + EdgeOne Makers reader deploys | first production Full Sync dispatch |
| image routing/CDN verification | `production-acceptance.md` GO/NO-GO |
