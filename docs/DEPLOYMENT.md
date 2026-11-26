# AiringCal deployment guide (authoritative)

**One normal entry point: `pnpm run setup`.** It needs only two masked tokens
and discovers/derives the account, workers.dev subdomain, Bangumi identity and
`USERS_JSON` — no manually edited dotenv file. (`pnpm setup` without `run`
is pnpm's own shell-setup command, not the AiringCal wizard.) This guide is
authoritative for the interactive flow and its advanced/headless alternative
(`scripts/deploy-env.mjs`, `pnpm run setup --headless`). Per-environment evidence
lives in [`v3/development-live-acceptance.md`](v3/development-live-acceptance.md)
and [`v3/production-acceptance.md`](v3/production-acceptance.md); this file is
the procedure, those files are the receipts.

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
WAF/cache/CORS, `bucket-domain` mode) is a **legacy opt-in that must be stated
explicitly** with `AIRINGCAL_PUBLIC_ORIGIN_MODE=bucket-domain`; #195 never
infers it from a URL host (a Worker custom domain resolves to `worker` mode via
`AIRINGCAL_WORKER_CUSTOM_DOMAIN`). The live `airingcal.223.im` topology runs in
that legacy mode. The Worker never exposes
checkpoints (no listing, no key passthrough, GET/HEAD only, pointer refs
prefix-allowlisted).
EdgeOne Makers mirrors the same static Reader for the overseas domain and
consumes the controlled interface above — it never fetches raw bucket keys.

Writes never happen in the read deploy: publishing is the GHA Portable Builder
(`.github/workflows/portable-writer.yml`), gated by the repo-level
`AIRINGCAL_WRITER_ENABLED` on the schedule (job-level `if`) and, for the first
production run only, by the production-environment
`AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED` checked in a fails-closed first
step inside the job; development dispatches are gated the same way by the
development-environment `AIRINGCAL_DEVELOPMENT_WRITER_ENABLED`.

## Prerequisites

- Node 24 + `pnpm`, `wrangler` and `gh` CLI authenticated (`gh auth status`).
- Production needs an independently scoped Cloudflare management token for
  R2 and Worker deployment, plus a verified Cloudflare account ID (32-char
  hex). **Worker mode (the default) needs no Zone ID.** A Zone ID is required
  only for a Worker custom domain binding or the explicit legacy
  `AIRINGCAL_PUBLIC_ORIGIN_MODE=bucket-domain` topology, and those paths also
  need the matching DNS/WAF permissions.
- EdgeOne API token (only when `target` includes `edgeone`).
- Bangumi token for the writer.
- DNS ownership of the public base domain (a custom-domain cutover creates the
  Worker route only when the operator chose that hostname).

## Interactive setup (`pnpm run setup`)

The canonical installation path (#195). It requires only the two masked
tokens and `gh auth login`; everything else is discovered or defaulted:

```bash
pnpm install
pnpm run setup                 # interactive menu loop: install/update, validate, doctor, exit
pnpm run setup --doctor        # read-only gates/workflows/recent runs
pnpm run setup --sync          # re-dispatch the first Full Sync (gate-monitored)
pnpm run setup --headless --environment development   # env/dotenv-driven, no prompts
# headless --sync additionally needs AIRINGCAL_WIZARD_SYNC_AUTHORIZED=yes
```

Flow: preflight (Node/gh/wrangler) → environment (Production default, with a
note that Development may reconfigure an existing Development deployment) →
credential sections with guide links and inline read-only validation (user-facing
summary + detailed `VERIFIED` / `MISSING` / `NOT_VERIFIED` / `NOT_APPLICABLE`
view; missing mandatory permissions block and offer re-entry/retry/menu/cancel;
validated credentials stay in process memory for reuse in the same session) →
account discovery (one auto-selects; multiple prompt) → workers.dev subdomain
discovery → `/v0/me` identity → `USERS_JSON` derivation → optional Worker Custom
Domain (zone discovery, DNS occupancy check, explicit takeover confirmation) →
partial-state discovery (`discoverPartialState`: if `airingcal-production`
already exists, shows observed metadata + prior local inventory match and
requires explicit Owner adoption confirmation; unrelated buckets stay untouched) →
concise Configuration Review with edit actions (credentials/domain/environment;
edits revalidate and rebuild the plan) → installation confirmation → apply
through the same engine and gates as the CLI (Production order: bucket
provisioning/adoption → dedicated bucket-scoped Writer token provisioning +
policy/access readback or masked S3 fallback → object-level empty-bucket check →
`r2.dev` disable → GitHub Environment sync → Reader deploy → isolation probe;
point-of-execution mutation ledger records confirmed/failed/unknown/compensation
outcomes; recoverable failures open an action-gated recovery menu instead of
terminating) → optional First Full Sync (separate authorization) → live
verifier → sanitized inventory at `.airingcal/inventory.<env>.json` (0600,
gitignored; distinguishes `planned` vs `observed` vs `resources`, `attemptedAt`
vs `deployedAt`, `writerCredentialState`, and `mutationReceipts`; never stores
secret values). Cloudflare is the default and only provider in a normal
installation; EdgeOne remains an explicit advanced target.

When `Validate API Credentials` or `Doctor` is chosen from the interactive main
menu, the wizard presents post-action options (`Continue to Installation`, `View
Detailed Results`, `Revalidate Credentials`, `Return to Main Menu`, `Exit`)
instead of exiting immediately. Validated credentials remain in process memory
only and are cleared on exit or replacement; any change to account, environment,
or custom-domain options triggers revalidation, and installation/sync
confirmations are never carried over across attempts.

Operator UI environment: `AIRINGCAL_THEME=auto|dark|light` (neutral foreground
palette; terminal background never changed), `NO_COLOR` (disables color and
hyperlinks), `AIRINGCAL_WIZARD_PLAIN_PROMPTS=1` (line-based prompts),
`AIRINGCAL_WIZARD_VERBOSE=yes` (prints the detailed execution plan as well as
the summary). Blog guide URLs are configured with
`AIRINGCAL_DOC_CLOUDFLARE_SETUP_GUIDE_URL`, `AIRINGCAL_DOC_BANGUMI_SETUP_GUIDE_URL`
and `AIRINGCAL_DOC_DEPLOYMENT_GUIDE_URL`; until set, the wizard shows the
repository guide and the official provider pages, never a placeholder URL.

Safety properties:

- Secrets are read in raw mode, echoed as `*`, kept in memory, never placed in
  argv or shell history, and never persisted to dotenv unless the operator
  writes them there explicitly.
- Production apply still runs the three existing gates; the interactive
  confirmation translates into `AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes` +
  `AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes` for that execution only.
- Headless is strictly env-driven: it never prompts (missing tokens fail with
  the exact variable names). `--headless --environment production` additionally
  requires `AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes` and
  `AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes` in `.env.production`/the shell — the
  wizard never manufactures them from `AIRINGCAL_WIZARD_CONFIRM`.
- An environment-supplied `AIRINGCAL_WORKER_CUSTOM_DOMAIN`/`AIRINGCAL_ZONE_ID`
  is checked and bound as exactly that value (DNS occupancy included); replacing
  an existing record non-interactively requires
  `AIRINGCAL_ALLOW_CUSTOM_DOMAIN_TAKEOVER=yes`. S3 overrides and
  `AIRINGCAL_WRITER_TOKEN_ROTATION_ID` from the source env are forwarded to the
  engine unchanged.
- First sync verifies the remote ref head, opens only the environment's
  temporary gate variable, closes it as soon as the run passes its gate step,
  and closes it again in cleanup on failure/timeout/cancellation; the
  repo-level schedule gate is never touched. A workflow that was
  `disabled_manually` is re-disabled after the run.
- Interruption / partial-init recovery: re-run `pnpm run setup` to reconcile
  observed resources against `.airingcal/inventory.<env>.json` and adopt an
  existing empty Production bucket with explicit confirmation (or pass
  `AIRINGCAL_ADOPT_EXISTING_BUCKET=yes` in explicit headless recovery), or run
  `pnpm run setup --doctor` to inspect gate states and active runs. Unrelated
  buckets are never touched, nonempty buckets are refused closed, and
  unproven existing buckets require explicit Owner adoption confirmation.

## Configuration

**Advanced/headless only.** The interactive wizard needs no dotenv file. For
automation or a deliberately explicit configuration, per-environment dotenv
files are never committed: `.env.development`, `.env.production`
(`deploy-env.mjs` accepts only these two selectors; the legacy `.env.staging`
belongs solely to the frozen `scripts/setup-staging.sh` rollback flow).
Production headless apply requires `AIRINGCAL_DOTENV_PATH` to point at
`.env.production` plus both apply gates. Use an isolated process with no
Development/Staging settings or generic credential aliases inherited from the
shell. Production loads file values over process values and rejects nonempty
`AIRINGCAL_STAGING_*`/`AIRINGCAL_DEVELOPMENT_*` process values. Keep the two
apply-confirmation variables out of dotenv.

| Name | Kind | Meaning |
|---|---|---|
| `AIRINGCAL_ENV` | required selector | `development` \| `production` — the deploy CLI **rejects** `staging` and has no `--env` flag; legacy staging is only the frozen `scripts/setup-staging.sh` rollback source |
| `AIRINGCAL_DOTENV_PATH` | required for production | path to `.env.production` |
| `AIRINGCAL_PUBLIC_BASE_URL` | optional | unset → **`worker` mode** (Worker origin is the public surface, bucket fully private). With a Worker custom domain, set `https://<custom-domain>` plus `AIRINGCAL_WORKER_CUSTOM_DOMAIN=<custom-domain>`. The legacy `bucket-domain` mode requires the explicit `AIRINGCAL_PUBLIC_ORIGIN_MODE=bucket-domain` selector and a real R2 custom-domain URL — never a placeholder or `r2.dev`; it is never inferred (#195). |
| `AIRINGCAL_WORKER_CUSTOM_DOMAIN` | optional | hostname bound as a Worker `custom_domain` route (worker mode); DNS/TLS provisioned by Cloudflare, existing records require explicit takeover confirmation |
| `AIRINGCAL_CORS_ORIGINS` | optional (worker mode) | comma-separated **exact** origins allowed cross-origin (`null` for file:// embeds); wildcards refused at config time; unset keeps OPTIONS at 405 and CORS an edge concern |
| `AIRINGCAL_WORKERS_DEV_SUBDOMAIN` | optional | account's workers.dev subdomain for origin rendering (the wizard discovers it; default `r7a` for the existing account) |
| `AIRINGCAL_ZONE_ID` | required only for a Worker custom domain or explicit `bucket-domain` mode | Cloudflare zone (domain/DNS/WAF rules); **worker mode without a custom domain needs none** |
| `AIRINGCAL_CLOUDFLARE_API_TOKEN` | required secret | independently scoped Production management token. Verify permissions and account identity before Apply. |
| `AIRINGCAL_CLOUDFLARE_ACCOUNT_ID` | required at apply | 32-char hex |
| `AIRINGCAL_BANGUMI_TOKEN` | required secret | writer token (synced to GitHub, never used by deploy reads) |
| `AIRINGCAL_EDGEONE_API_TOKEN` | required for target≠cloudflare | EdgeOne token |
| `AIRINGCAL_DEPLOY_TARGET` | optional | `cloudflare` \| `edgeone` \| `both` (default `both`) |
| `AIRINGCAL_PRIMARY_USER_ID` | **required for production**; needed for dev/staging env sync | writer owner uid; production `--apply` sync refuses without it (the first Full Sync validates the derived variable as required) |
| `AIRINGCAL_USERS_JSON` | **required for production**; optional dev/staging (dev falls back to the verified staging env value) | writer users payload → `AIRINGCAL_PRODUCTION_USERS_JSON`; production sync fails closed when empty |
| `AIRINGCAL_IMAGE_BASE_URL` | optional | sticky image base override; deploy clears it when unset |
| `AIRINGCAL_S3_ACCESS_KEY_ID` / `AIRINGCAL_S3_SECRET_ACCESS_KEY` / `AIRINGCAL_S3_REGION` | optional overrides | Supply independently scoped Production S3 access when management-token self-derivation is unsuitable. Production Apply does not create or rotate API tokens. |
| `AIRINGCAL_PRODUCTION_WORKER_NAME` / `AIRINGCAL_EDGEONE_PROJECT` / `AIRINGCAL_EDGEONE_REGION` | optional | resource-name overrides |
| `AIRINGCAL_WRITER_ENABLED` | GitHub **repo** variable, not dotenv | schedule gate — the only gate scope a job-level `if` can read; deploy never flips it |
| `AIRINGCAL_DEVELOPMENT_WRITER_ENABLED` | GitHub **development environment** variable | development dispatch gate, checked by the first step inside the job (job-level `if` cannot resolve environment-scoped vars); deploy pins it `false`; `runSingleWriterTest` flips the same environment scope and restores `false` |
| `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED` | GitHub **production environment** variable | first-sync gate, checked by the first step inside the production job (fails closed, value never logged); deploy pins it `false`, Owner sets `true` once, dispatches, clears |

Legacy `AIRINGCAL_STAGING_*` names still load through a compatibility alias map
and print a deprecation note; prefer the environment-neutral names above.

## Preflight (read-only, default)

```bash
AIRINGCAL_ENV=development node scripts/deploy-env.mjs --dry-run
AIRINGCAL_ENV=production AIRINGCAL_DOTENV_PATH=.env.production \
  node scripts/deploy-env.mjs --dry-run --target cloudflare
```

Dry-run prints the full ordered step plan, resource names, derived values and
`refusedMutations: true`. It never touches Cloudflare, EdgeOne, GitHub or DNS.
Production dry-run embeds `preflight-identity.gitSha`; inspect the entire plan
for Worker mode, an independent Worker and bucket, and no copy, DNS, custom
domain, EdgeOne, or Writer changes. Separately verify the remote account,
zone, permissions and GitHub state. Validate `AIRINGCAL_USERS_JSON` against
the [sync config parser](../apps/node-jobs/src/sync/config.ts) with the
matching `AIRINGCAL_PRIMARY_USER_ID` before creating resources.

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

Production apply exists and is wired, but requires three explicit gates, all
refusing before any mutation: missing `--i-am-sure-production` exits **1** at
argument resolution; missing `AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED` or
`AIRINGCAL_DEPLOY_LIVE_CONFIRM` prints the plan (or owner-gated payload) and
exits **2**. Once the executor runs, the result JSON's `mutationsExecuted`
lists the completed steps that could touch external state (empty when only
probes ran before an abort):

```bash
AIRINGCAL_ENV=production AIRINGCAL_DOTENV_PATH=.env.production \
AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes \
AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes \
  node scripts/deploy-env.mjs --apply --i-am-sure-production --target cloudflare
```

The production sequence is **copy-free**: it never reads or copies staging or
development data. `ensure-bucket` refuses a non-empty `airingcal-production`
bucket (the one exception being a provable leftover isolation-probe object,
verified against the known probe body and deleted before re-checking emptiness
under the clean-bootstrap guard). Leave `AIRINGCAL_PUBLIC_BASE_URL` unset.
This plan deploys the Production
Cloudflare Worker without any R2 Custom Domain or DNS changes. `checkpoints/`
isolation requires authenticated S3 HEAD of the test object, anonymous
GET/HEAD denial at the Worker and verified cleanup. Check that no public R2
endpoint exists and the bucket is still empty. A fresh Reader can serve
static assets while release-dependent APIs return `503 NO_RELEASE` and the
image routing check records `skipped-no-release`. Apply syncs the `production`
Environment and pins its bootstrap Writer gate `false`. If Apply aborts,
record `mutationsExecuted` and inspect the remote state of the incomplete
operation before any retry.

## First data load (Production)

After D2 Apply and isolation pass, obtain separate Owner authorization for
D3. Verify the exact candidate ref/SHA, Production Environment restrictions
and config, no active Writer and no existing Production release or
checkpoint. Read the prior Portable Writer workflow state and verify the
repository `AIRINGCAL_WRITER_ENABLED` gate is closed. Enable the shared
workflow only if dispatch requires it, with the schedule gate kept closed.

Set the Production Environment variable
`AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED=true` only for the intended
`portable-writer.yml` dispatch on that ref, with `target=production` and
`force_mode=full`. Establish a bounded watchdog and cleanup before opening
the gate. Close it immediately after the intended job passes
`Production bootstrap gate (fails closed)`. On timeout, interruption,
dispatch failure or cancellation, close it first and reconcile the run.
Verify the gate reads back `false`, record the run ID and SHA, observe it
through terminal completion, and restore the prior workflow state if it was
temporarily enabled. Inspect the actual bucket before any recovery from a
partial publication.

See the [Writer operations guide](v3/gha-portable-writer.md) for other
environments.

## Verify

```bash
# accept/bench have no --env/--json flags (they print JSON by default); hosts
# come from --public-base / --hosts, fixture paths from --baseline/--post.
pnpm exec tsx scripts/reader-delivery-accept.mjs --public-base <reader-origin>
pnpm exec tsx scripts/reader-delivery-bench.mjs --hosts <cf-origin>,<eo-origin> --runs 3
node scripts/v3-ship-verify.mjs --base https://airingcal.teijp.cn --json   # or --public-dir <mirror>
node scripts/v3-ship-verify.mjs --base <worker-origin-url> --bucket airingcal-development --json   # positive private-object proof
node scripts/v3-ship-verify.mjs --base <production-worker-origin> --bucket airingcal-production --json
```

`v3-ship-verify.mjs` runs every read-surface probe automatically: static
index/Widget assets, pointer identity, API shape, method allowlist (405 +
`Allow`), conditional GET (`ETag`/304 on `/api/collections`, `/api/calendar`,
`/api/cache`), `checkpoints/**` isolation — including the **positive
private-object proof** when `--bucket` is supplied (read-only S3 list+HEAD of a
real `checkpoints/` object followed by anonymous GET/HEAD denial through the
same reader base; an anonymous 404 over a bucket that holds nothing proves
nothing) — and image delivery (original + optional thumb). It is strictly
read-only and exits non-zero on any failed check; without `--bucket`/mirror
`checkpoints/` the proof fails closed unless the operator states the skip via
`--allow-unproven-isolation` (visible in the JSON). Production requires
unskipped proof plus the supplemental checks in the
[acceptance checklist](v3/production-acceptance.md#7-cloudflare-worker-live-read-contract).

## Update / rollback

- Development config or code change: use its authorized deploy procedure.
  Production clean-bootstrap Apply refuses a bucket with published data.
  Writer cadence is data-only and needs no Reader redeploy.
- Release rollback/roll-forward (pointer flip, CAS-safe):
  [`v3/cutover-rollback.md`](v3/cutover-rollback.md).
- Production acceptance checklist before Owner GO:
  [`v3/production-acceptance.md`](v3/production-acceptance.md).

## What deploy-env automates vs what stays Owner-run

| Automated by Production Apply in Worker mode | Separate Owner authorization |
|---|---|
| Empty R2 bucket, `r2.dev` disabled, isolation proof | First Production Full Sync |
| Production GitHub Environment sync, bootstrap gate pinned off | Live rollback/roll-forward and traffic cutover |
| Cloudflare Worker deployment | Scheduled Writer enablement and formal release |
