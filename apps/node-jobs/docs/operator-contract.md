# node-jobs operator contract (AC-1-08)

Canonical env, timeouts, and exit behavior for **QingLong** and local CLI. QingLong wrapper codes: [QINGLONG errors/airingcal-sync](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/errors/airingcal-sync.md).

## CLI

| Command | Entry |
| --- | --- |
| Sync | `airingcal-sync.mjs` → `runSync()` |
| Backup | `airingcal-backup.mjs` → `runBackup()` |

Build: `pnpm -F @airing-cal/node-jobs build` → `dist/qinglong-bundle/`.

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

When `AIRINGCAL_BUILDER=portable`, `runSync()` uses `@airing-cal/v3-builder` (SQLite checkpoint) instead of the Cloudflare D1/R2/KV pipeline. Default remains the legacy data-plane path.

| Variable | Required (portable) | Notes |
| --- | --- | --- |
| `AIRINGCAL_BUILDER` | yes | Must be `portable` |
| `AIRINGCAL_BUILDER_SQLITE_PATH` | yes | Local filesystem path; parent dirs created |
| `AIRINGCAL_USERS_JSON`, `AIRINGCAL_PRIMARY_USER_ID`, `BANGUMI_GIT_COMMIT_SHA` | yes | Same as cloud sync |
| `BGM_TOKEN` | yes | Bangumi fetch |
| `AIRINGCAL_BUILDER_MODE` | no | `incremental` (default) or `full` |
| `AIRINGCAL_BUILDER_PUBLISH` | no | `true` runs checkpoint publish after sync |
| `AIRINGCAL_BUILDER_PUBLIC_DIR` | when publishing | Root for immutable snapshot objects + `public/current-release.json` pointer (filesystem `PublicStore`) |
| `AIRINGCAL_BUILDER_OWNER` | no | Lease owner token; defaults per run |

When `AIRINGCAL_BUILDER_PUBLISH=true` and `AIRINGCAL_BUILDER_PUBLIC_DIR` is unset, publish uses in-process memory only (dev smoke; not durable).

| `AIRINGCAL_BUILDER_MEDIA_REFRESH` | no | `skip` (default): no Bangumi image download; snapshot `image_status` reflects source URLs only. `refresh`: **not implemented** — fails closed until filesystem media store lands. |

Portable sync **does not** read Cloudflare R2/D1/KV, **does not** call `AIRINGCAL_THUMB_GEN_*` / Worker thumb-gen, and **does not** download cover bytes today.

Cloudflare variables are **not** read on the portable path.

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

### Cover thumb pipeline (AC-2, optional)

After sync media refresh persists large covers to R2, node-jobs may **fire-and-forget** batch `POST` to web-worker `/api/thumb-gen`. Failures are logged only; sync does **not** fail on 5xx.

| Variable | Required | Notes |
| --- | --- | --- |
| `AIRINGCAL_THUMB_GEN_URL` | no | Full URL to `/api/thumb-gen`; omit to disable |
| `AIRINGCAL_WEB_ORIGIN` | no | Used when URL unset: `{origin}/api/thumb-gen` |
| `AIRINGCAL_THUMB_GEN_BEARER` | when URL/origin set | Must match Worker secret **`THUMB_GEN_BEARER`** |

QingLong wrapper preflight (when URL is set) expects unauthenticated `POST` → **401**; see QINGLONG-REPO `AIRINGCAL_SKIP_THUMB_GEN_PROBE`.

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
