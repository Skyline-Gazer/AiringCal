# GHA portable writer (ADR 0003)

> **Activation gate (2026-11-05):** The default-branch schedule is disabled at the job level unless repository variable `AIRINGCAL_WRITER_ENABLED` is exactly `true`. Do not enable it until real isolated R2 staging, reader parity and owner cutover approval (#147). Manual `workflow_dispatch` is the explicit smoke path; use staging-scoped credentials. `dev` push never deploys the read Worker or applies remote D1 migrations after the PR CI gate change. A real public CDN URL is not configured in `wrangler.toml` by default; the read Worker falls back to its legacy image store until an operator sets and verifies the runtime variable. No Docker/CNB/QingLong delivery. This PR is not proof of production-live sync.

Status: **implemented in repo; not production-live until Secrets/Variables are filled and a successful `workflow_dispatch` is observed.**

Decision: [`../plans/adr-0003-gha-portable-write.md`](../plans/adr-0003-gha-portable-write.md).

## What runs

| Piece | Path |
| --- | --- |
| Workflow | `.github/workflows/portable-writer.yml` |
| Shell entry | `scripts/gha-portable-writer.sh` |
| Orchestrator | `apps/node-jobs/src/cli/gha-portable-writer.ts` (+ `-main.ts`) |
| Schedule | cron `0 20 * * *` UTC = **04:00 Asia/Shanghai** |
| Mode | Checkpoint self-judge (≥7 days since last successful **full** → full); `workflow_dispatch` may set `force_mode` |

Flow: acquire lease → restore SQLite checkpoint from **private** R2 → sync portable builder → publish Release + mirror `images/**` to **public** R2 → upload checkpoint → release lease. Failure → Bark (`BARK_URL`).

## Operator fill-in (Secrets / Variables)

Replace every `PLACEHOLDER_*` with real values. Create **two** R2 buckets (private checkpoint ≠ public release).

### Repository Secrets

| Secret | Example / placeholder | Notes |
| --- | --- | --- |
| `BGM_TOKEN` | Bangumi access token | Required for sync |
| `AIRINGCAL_USERS_JSON` | `[{"id":"…","username":"…"}]` | Same contract as node-jobs |
| `AIRINGCAL_PRIMARY_USER_ID` | Bangumi user id string | |
| `BARK_URL` | `https://api.day.app/<device_key>` | Failure push; omit to skip notify |
| `AIRINGCAL_CHECKPOINT_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | Private bucket API |
| `AIRINGCAL_CHECKPOINT_S3_REGION` | `auto` | Optional (defaults `auto`) |
| `AIRINGCAL_CHECKPOINT_S3_BUCKET` | e.g. `airingcal-checkpoint` | Private |
| `AIRINGCAL_CHECKPOINT_S3_ACCESS_KEY_ID` | R2 API token access key | Checkpoint only |
| `AIRINGCAL_CHECKPOINT_S3_SECRET_ACCESS_KEY` | R2 API token secret | Checkpoint only |
| `AIRINGCAL_PUBLIC_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | May share account with checkpoint |
| `AIRINGCAL_PUBLIC_S3_REGION` | `auto` | Optional |
| `AIRINGCAL_PUBLIC_S3_BUCKET` | e.g. `airingcal-public` | Public release + images |
| `AIRINGCAL_PUBLIC_S3_ACCESS_KEY_ID` | R2 API token access key | Public bucket |
| `AIRINGCAL_PUBLIC_S3_SECRET_ACCESS_KEY` | R2 API token secret | Public bucket |

### Repository Variables

| Variable | Example / placeholder | Notes |
| --- | --- | --- |
| `AIRINGCAL_PUBLIC_BASE_URL` | verified real public CDN host (optional) | Configure separately in the **read Worker** runtime only after staging. Never deploy `PLACEHOLDER_PUBLIC_CDN`: without a configured URL, the Worker keeps its existing image fallback. Writer job does not require it. |

### Local / non-Actions env (optional)

Same names as above. Also:

| Env | Default in shell | Notes |
| --- | --- | --- |
| `AIRINGCAL_BUILDER_SQLITE_PATH` | `/tmp/airingcal-builder.sqlite` | Working set |
| `AIRINGCAL_BUILDER_IMAGE_DIR` | `/tmp/airingcal-images` | Local media before S3 mirror |
| `AIRINGCAL_FULL_EVERY_DAYS` | `7` | Full interval |

## Smoke

1. Fill Secrets (and optional `AIRINGCAL_PUBLIC_BASE_URL`).
2. Actions → **Portable writer (GHA)** → `workflow_dispatch` (optional `force_mode=full`).
3. Expect job exit 0, checkpoint object `checkpoints/builder.sqlite`, public pointer `public/current-release.json`, and Bark silent on success.

## Not in this slice / remaining backlog

- Non-R2 S3 vendor verification (TODO)
- Netlify / Vercel read adapters (TODO)
- Enabling the schedule before the first manual green run (owner choice; needs Secrets)
- Physical deletion of unused D1 adapter modules still used by `portable-legacy-*` migration CLIs
