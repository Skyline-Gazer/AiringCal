# node-jobs operator contract (AC-1-08)

Canonical env, timeouts, and exit behavior for the **GHA portable writer** and local CLI
(ADR 0003). Ops fill-in: [`docs/v3/gha-portable-writer.md`](../../../docs/v3/gha-portable-writer.md).
Historical QingLong wrapper codes (archive only): [QINGLONG errors/airingcal-sync](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/errors/airingcal-sync.md).

## CLI

| Command | Entry |
| --- | --- |
| GHA writer | `gha-portable-writer.mjs` → `runGhaPortableWriter()` |
| Sync | `airingcal-sync.mjs` → `runSync()` (portable-only) |
| Backup | `airingcal-backup.mjs` → `runBackup()` (legacy D1 export; migration/ops) |

Build: `pnpm -F @airing-cal/node-jobs build` → `dist/portable-bundle/` (`airingcal-sync.mjs`, `gha-portable-writer.mjs`).

## Timeouts

| Job | Run deadline | Notes |
| --- | --- | --- |
| **sync** | **25 min** (`deadlineAt = now + 1_500_000 ms`) | Media stops when under 30s left; snapshot may still publish |
| **backup** | **10 min** (`600_000 ms`) | D1 export poll + download ≤ **256 MiB** |
| HTTP (adapters) | Per-request via `RunContext.signal` | Abort → `REQUEST_FAILED` |

Lease default: **`airingcal-data-plane`**, **900s** (sync and backup).

## Process exit codes

| Exit | Meaning |
| --- | --- |
| **0** | Last line JSON `status`: `success` or `skipped` |
| **1** | `status`: `failed`, or uncaught exception |

### JSON summary (`stdout` last line)

```json
{ "job": "airingcal-sync", "status": "success|skipped|failed", "message": "..." }
```

`exitCode()` in `src/contracts.ts`: failed → 1, else 0.

### Skip (exit 0)

| Condition | message hint |
| --- | --- |
| `AIRINGCAL_USERS_JSON` empty | not configured |
| Lease held | `lease_busy` / skipped stage |

## Bundle `JobError.code` (sync/backup)

| Code | Typical cause |
| --- | --- |
| `CONFIG_INVALID` | Missing/malformed env |
| `D1_REQUEST_FAILED` | D1 REST error |
| `D1_EXPORT_*` | Backup export poll/download |
| `KV_REQUEST_FAILED` | KV write/read (sync publish) |
| `LEASE_LOST` | Lease expired mid-run |
| `R2_*` | Snapshot or image bucket S3 |
| `REQUEST_FAILED` | Bangumi/upstream or deadline |
| `UPSTREAM_UNAVAILABLE` | BGM client |

Full enum: `src/adapters/errors.ts`.

## Portable builder sync (v3, optional)

`runSync()` is **portable-only** (`@airing-cal/v3-builder`, SQLite checkpoint) per ADR 0003. `AIRINGCAL_BUILDER=legacy-d1` / `legacy` / `cloudflare` returns failed (retired).

| Variable | Required (portable) | Notes |
| --- | --- | --- |
| `AIRINGCAL_BUILDER` | no | Default / only supported value: `portable` (or unset). |
| `AIRINGCAL_BUILDER_SQLITE_PATH` | yes | Local filesystem path; parent dirs created |
| `AIRINGCAL_USERS_JSON`, `AIRINGCAL_PRIMARY_USER_ID`, `BANGUMI_GIT_COMMIT_SHA` | yes | Same as cloud sync |
| `BGM_TOKEN` | yes | Bangumi fetch |
| `AIRINGCAL_BUILDER_MODE` | no | `incremental` (default) or `full` |
| `AIRINGCAL_BUILDER_PUBLISH` | no | `true` runs checkpoint publish after sync |
| `AIRINGCAL_BUILDER_PUBLIC_DIR` | when publishing (filesystem) | Root for immutable snapshot objects + `public/current-release.json` pointer (filesystem `PublicStore`) |
| `AIRINGCAL_PUBLIC_S3_*` | when publishing (S3/R2) | If set, portable publish uses S3-compatible `PublicStore` instead of `PUBLIC_DIR` (see ADR 0003 / `docs/v3/gha-portable-writer.md`) |
| `AIRINGCAL_BUILDER_OWNER` | no | Lease owner token; defaults per run |

When `AIRINGCAL_BUILDER_PUBLISH=true` and neither `AIRINGCAL_PUBLIC_S3_*` nor `AIRINGCAL_BUILDER_PUBLIC_DIR` is set, publish uses in-process memory only (dev smoke; not durable).

### GHA one-shot writer (ADR 0003)

Entry: `scripts/gha-portable-writer.sh` → `tsx src/cli/gha-portable-writer-main.ts`. Workflow: `.github/workflows/portable-writer.yml` (04:00 Asia/Shanghai). Requires `AIRINGCAL_CHECKPOINT_S3_*` for durable SQLite checkpoint + lease, and `AIRINGCAL_PUBLIC_S3_*` for Release publish. Optional `BARK_URL` on failure. Fill-in list: [`docs/v3/gha-portable-writer.md`](../../../docs/v3/gha-portable-writer.md).

| `AIRINGCAL_BUILDER_MEDIA_REFRESH` | no | `skip` (default): no download; URL-only `image_status`. `refresh`: download covers to filesystem via builder SQLite `subject_media` (requires `PUBLIC_DIR` or `IMAGE_DIR`). |
| `AIRINGCAL_BUILDER_IMAGE_DIR` | when refresh without `PUBLIC_DIR` | Root for immutable `images/{hash}/original` blobs (same key layout as R2). |

Portable sync **does not** read Cloudflare R2/D1/KV or call Worker `AIRINGCAL_THUMB_GEN_*`. With `MEDIA_REFRESH=refresh`, cover bytes and optional offline `thumb.v2.webp` (320×427 WebP q78) land on the filesystem store.

Cloudflare variables are **not** read on the portable path.

### Historical: QingLong / Compose scheduler

QingLong + `qinglong-bundle` and Compose `portable-scheduler` are **removed** as production writers (ADR 0003). Use [GHA portable writer](../../../docs/v3/gha-portable-writer.md). Local Compose **web** / optional `sync` profile: [`deploy/v3/README.md`](../../../deploy/v3/README.md).

One-shot checkpoint backup: `tsx apps/node-jobs/src/cli/portable-checkpoint-backup.ts`. Restore: `tsx apps/node-jobs/src/cli/portable-checkpoint-restore.ts <backup.sqlite>` (add `--force` to overwrite an existing file).

Cutover + rollback runbook (#73, owner-approved, never executed by CI): [`docs/v3/cutover-rollback.md`](../../../docs/v3/cutover-rollback.md) — preconditions (shadow gate 0, import complete, fresh checkpoint backup), cutover commands, rollback via checkpoint restore + re-publish, and the executed local rollback drill.

Non-secret env from the v1 config (`airingcal.yaml` — the documented format — or the equivalent JSON; secrets such as `BGM_TOKEN` stay in `.env`): `tsx apps/node-jobs/src/cli/airingcal-config-emit.ts docs/v3/airingcal-config.example.yaml`. Validate: `tsx apps/node-jobs/src/cli/airingcal-config-validate.ts <path>`. Non-interactive setup: `tsx apps/node-jobs/src/cli/airingcal-setup.ts <path> [--emit-env]` — `portable` emits the builder/read/scheduler/gc env and lists its secrets; `cloudflare` emits only `AIRINGCAL_PLATFORM` plus the `wrangler.toml` bindings to declare (the release is still built by the portable/Compose builder); `edgeone` fails closed until the adapter exists. See [`docs/v3/airingcal-config.example.yaml`](../../../docs/v3/airingcal-config.example.yaml) (JSON twin: `airingcal-config.example.json`).

Interactive secrets entry (optional): add `--interactive --secrets-out <path>` to `airingcal-setup.ts`; it prompts per required key (blank/EOF skips), writes only the entered values to `<path>` with `0600` permissions, and never prints or emits them. Non-interactive runs keep secrets in the environment.

Read-only snapshot equivalence (migration smoke, #73 prep): `tsx apps/node-jobs/src/cli/portable-snapshot-compare.ts <left.json> <right.json>` (exit 2 on diff). Normalize v2 R2 snapshot or legacy KV export before compare: `tsx apps/node-jobs/src/cli/portable-v2-public-normalize.ts <public.json> [hydrated.json]`.

Read-only v2 legacy state import (#73): `tsx apps/node-jobs/src/cli/portable-legacy-state-import.ts <kv-export.json> --sqlite <path> [--snapshot <PublicSnapshotV1.json>|--subject-ids <ids>] [--batch-size N] [--resume]`. Writes `subject_media` rows and the migration cursor/summary into the builder SQLite only (never the public store); ≤50 subjects per batch, idempotent, resumable via `--resume`. See [`docs/v3/legacy-state-import.md`](../../../docs/v3/legacy-state-import.md).

Read-only legacy KV export (#73, needs Cloudflare credentials — see below): `tsx apps/node-jobs/src/cli/portable-legacy-export.ts --out <kv-export.json> [--account-id <id>] [--namespace-id <id>] [--prefix <p>] [--page-limit N] [--allow-empty]`. Lists the legacy KV prefixes (`subject:detail:`, `subject:meta:`, `image:status:`, `subject:refresh:`) and bulk-reads their JSON values into the local file; no Cloudflare write. See [`docs/v3/legacy-state-import.md`](../../../docs/v3/legacy-state-import.md).

Shadow-equivalence gate (#73): `tsx apps/node-jobs/src/cli/portable-shadow-gate.ts --sqlite <path> --legacy <legacy.json> --candidate <public-snapshot.json> [--hydrated <sidecar.json>] [--reset]`. Persists the consecutive-match streak in `builder_kv` (`migrate:shadow:streak`); exit `0` when 7 consecutive matches are reached, `2` otherwise. See [`docs/v3/shadow-gate.md`](../../../docs/v3/legacy-state-import.md).

Legacy per-subject KV cleanup (post-cutover, #139): `tsx apps/node-jobs/src/cli/portable-legacy-cleanup.ts [--dry-run]` (needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AIRING_CAL_D1_DATABASE_ID`, `AIRING_CAL_KV_NAMESPACE_ID`, `AIRING_CAL_R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`). Deletes the four legacy keys (`subject:detail:`, `subject:meta:`, `image:status:`, `subject:refresh:`) for at most 25 subjects (100 keys) per run, only when `migrate:read-mode` is `r2`, 14 days have elapsed since `switched_at`, and `public:current` resolves to a readable R2 object. Cursor persists in D1 `app_state['migrate:cleanup:cursor']`; a failing delete stops the run without advancing past the failed subject.

Public snapshot GC (snapshot JSON only, not images): `tsx apps/node-jobs/src/cli/portable-public-gc.ts` (default dry-run; pass `--apply` to delete). Optional `AIRINGCAL_GC_MIN_GENERATIONS` (default `5`), `AIRINGCAL_GC_MIN_AGE_DAYS` (default `30`, uses snapshot `published_at`), `AIRINGCAL_GC_PINNED` (comma-separated artifact refs). Image GC protects every retained snapshot — the current release AND its rollback candidates (`AIRINGCAL_GC_ROLLBACK_GENERATIONS`, default `2`, newest generations strictly below the current pointer) — and fails closed when a retained snapshot cannot be parsed; optional `AIRINGCAL_GC_PINNED_IMAGES` (comma-separated content hashes). CLI: default dry-run for snapshots and images; `--apply` deletes snapshot JSON only; `--apply-images` deletes unreferenced `images/{hash}/` trees (can combine with `--apply`). `AIRINGCAL_GC_LOG_AFTER_PUBLISH=true` logs a dry-run plan after successful portable publish (Compose default on scheduler/sync).

Release pointer rollback (C9): `tsx apps/node-jobs/src/cli/portable-release-rollback.ts --generation <N> [--apply --writer-frozen] [--receipt <path>]` — freeze the writer (`AIRINGCAL_WRITER_ENABLED=false`), CAS the public pointer back to a prior generation, and emit a receipt with the resume/convergence rule. See [`docs/v3/cutover-rollback.md`](../../../docs/v3/cutover-rollback.md). Shadow-gate checklist: [`docs/v3/shadow-gate-checklist.md`](../../../docs/v3/shadow-gate-checklist.md).

## Required env (sync)

See [`../env.example`](../env.example). Summary:

| Variable | Required |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | yes |
| `AIRING_CAL_D1_DATABASE_ID` | yes |
| `AIRING_CAL_R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | yes |
| `AIRING_CAL_IMAGE_BUCKET` | default `airing-cal-images` |
| `AIRING_CAL_KV_NAMESPACE_ID` | **yes for production read path** (writes `public:current`, `public:read-mode`) |
| `AIRINGCAL_USERS_JSON`, `AIRINGCAL_PRIMARY_USER_ID`, `BANGUMI_GIT_COMMIT_SHA` | yes |
| `BGM_TOKEN` | optional |

### Media retry policy (bounded)

A subject whose image download fails is retried with exponential backoff —
`6h → 12h → 24h → 48h → 96h` (`mediaRetryDelaySeconds`, capped at 7 days). After
`MEDIA_RETRY_LIMIT` (5) consecutive failures the row is marked
`MEDIA_IMAGE_FAILED_EXHAUSTED` and parked for 30 days, so a permanently broken
source cannot re-run on every sync. A later success resets `retry_count` and the
normal 6-day refresh cadence. Log lines: `media_failed` (retrying) and
`media_failed_exhausted` (parked), both with `retry_count`/`next_refresh_at`.

### Cover thumb pipeline (AC-2, optional)

After sync media refresh persists large covers to R2, node-jobs may **fire-and-forget** batch `POST` to web-worker `/api/thumb-gen`. Failures are logged only; sync does **not** fail on 5xx.

| Variable | Required | Notes |
| --- | --- | --- |
| `AIRINGCAL_THUMB_GEN_URL` | no | Full URL to `/api/thumb-gen`; omit to disable |
| `AIRINGCAL_WEB_ORIGIN` | no | Used when URL unset: `{origin}/api/thumb-gen` |
| `AIRINGCAL_THUMB_GEN_BEARER` | when URL/origin set | Must match Worker secret **`THUMB_GEN_BEARER`** |

Historical QingLong wrapper preflight (archive only; when URL was set it) expected unauthenticated `POST` → **401**; see QINGLONG-REPO `AIRINGCAL_SKIP_THUMB_GEN_PROBE`.

Backup uses same Cloudflare/R2/D1 vars; no Bangumi user JSON.

## Integration tests (AC-1-06)

Mock D1/R2 pipelines (no live CF/Bangumi):

- `src/sync/pipeline.test.ts`
- `src/backup/pipeline.test.ts`
- `src/sync/media-refresh.test.ts`
- `src/integration/lease.integration.test.ts`

Run: `pnpm -F @airing-cal/node-jobs test`.

## D1 setup

[`d1-schema.md`](d1-schema.md)
