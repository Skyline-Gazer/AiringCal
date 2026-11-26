# `@airing-cal/node-jobs` — Portable Writer Operator Contract

Canonical CLI entrypoints, environment variables, timeouts, exit codes, media retry rules, and garbage-collection behavior for the **GitHub Actions Portable Writer** (`.github/workflows/portable-writer.yml`) and local maintenance CLIs in AiringCal `v3.0.0`.

- Deployment & gate operations: [`docs/DEPLOYMENT.md`](../../../docs/DEPLOYMENT.md)
- System architecture & CAS lease model: [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md)
- Legacy recoverability record: [`docs/v3/release-acceptance-evidence.md`](../../../docs/v3/release-acceptance-evidence.md)

---

## 1. CLI Entrypoints & Bundle Build

Build the standalone Portable Writer bundle:

```bash
pnpm -F @airing-cal/node-jobs build
```

This emits `apps/node-jobs/dist/portable-bundle/`:
- `gha-portable-writer.mjs` → `runGhaPortableWriter()` (invoked by `apps/node-jobs/scripts/gha-portable-writer.sh` in `.github/workflows/portable-writer.yml`)
- `airingcal-sync.mjs` → `runSync()` (portable SQLite builder sync)

### Direct TypeScript Maintenance CLIs (`apps/node-jobs/src/cli/`)

| CLI Script | Purpose |
| :--- | :--- |
| `src/cli/gha-portable-writer-main.ts` | GitHub Actions one-shot Writer entrypoint (CAS lease → checkpoint restore → sync → CAS checkpoint upload + lease renew → atomic pointer commit → lease release) |
| `src/cli/portable-checkpoint-backup.ts` | Download and verify a local backup copy of `checkpoints/builder.sqlite` |
| `src/cli/portable-checkpoint-restore.ts` | Restore a verified local `.sqlite` backup file to the checkpoint store (`--force` to overwrite) |
| `src/cli/portable-public-gc.ts` | Snapshot and content-addressed image garbage collection (dry-run by default; `--apply` for snapshots, `--apply-images` for unreferenced images) |
| `src/cli/portable-release-rollback.ts` | Roll `public/current-release.json` back to a retained prior generation (`--generation <N> --apply --writer-frozen`) |
| `src/cli/portable-snapshot-compare.ts` | Compare two `PublicSnapshotV1` JSON files for semantic equality (exit `0` when equal, `2` on diff) |
| `src/cli/portable-shadow-gate.ts` | One-shot parity comparison between legacy export and candidate v3 snapshot |

---

## 2. Timeouts & Lease Discipline

| Parameter | Default Value | Description |
| :--- | :--- | :--- |
| **Sync Run Deadline** | `25 min` (`1,500,000 ms`) | Media downloads stop when `< 30s` remain so the snapshot and checkpoint can still commit cleanly |
| **Checkpoint Lease Key** | `checkpoints/lease.json` | Single-writer compare-and-swap (CAS) lease stored in the private R2 bucket |
| **Checkpoint Lease TTL** | `45 min` (`2,700 s`) | Acquired before checkpoint restore, renewed immediately before `public/current-release.json` commit, and expired on exit |

### Lease Cleanup Failure Surfacing

If `releaseCheckpointLease` fails in the cleanup phase after a sync run:
1. A structured error log (`stage: "checkpoint_lease_release_failed"`) is emitted with `owner`, `primary_status`, `error`, and `recovery` hint.
2. `result.leaseCleanup` is populated with `{ released: false, error, recoveryHint }` while preserving `result.summary`.
3. The Writer result is marked `status: "failed"` and triggers `notifyBarkFailure` (when `BARK_URL` is configured) so an unreleased lease never passes silently as an unqualified success.

---

## 3. Process Exit Codes & Output Format

| Exit Code | Meaning |
| :--- | :--- |
| **`0`** | Final JSON line has `"status": "success"` or `"status": "skipped"` (and `leaseCleanup.released !== false`) |
| **`1`** | Final JSON line has `"status": "failed"` (including lease contention, CAS precondition failure, sync error, or lease release failure) |
| **`2`** | Snapshot comparison / shadow-gate mismatch (`portable-snapshot-compare.ts`, `portable-shadow-gate.ts`) |

---

## 4. Environment Variables (`runGhaPortableWriter` & `runSync`)

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `AIRINGCAL_BUILDER` | No | `portable` | Must be `portable` (or unset); legacy values fail closed |
| `AIRINGCAL_BUILDER_SQLITE_PATH` | Yes | — | Local temporary path for restored/updated SQLite checkpoint |
| `AIRINGCAL_BUILDER_MODE` | No | Auto (`incremental` / `full`) | Explicit `full` or `incremental`; when unset, runs `full` every `AIRINGCAL_FULL_EVERY_DAYS` (default `7`) and `incremental` otherwise |
| `AIRINGCAL_FULL_EVERY_DAYS` | No | `7` | Cadence (in days) for automatic full reconciliation |
| `AIRINGCAL_USERS_JSON` | Yes | — | JSON array of tracked Bangumi users (`[{"userId":"...","username":"..."}]`) |
| `AIRINGCAL_PRIMARY_USER_ID` | Yes | — | Primary Bangumi user ID |
| `BGM_TOKEN` | Yes | — | Bangumi Personal Access Token |
| `BANGUMI_GIT_COMMIT_SHA` | Yes | — | Git commit SHA recorded in published release manifest metadata |
| `AIRINGCAL_PUBLIC_BASE_URL` | Yes | — | Reader Worker public origin URL |
| `AIRINGCAL_CHECKPOINT_S3_BUCKET` | Yes (GHA) | — | Private R2 bucket name (`airingcal-production` or `airingcal-development`) |
| `AIRINGCAL_CHECKPOINT_S3_ENDPOINT` | Yes (GHA) | — | Cloudflare R2 S3 endpoint (`https://<accountId>.r2.cloudflarestorage.com`) |
| `AIRINGCAL_CHECKPOINT_S3_REGION` | No | `auto` | S3 region (`auto` for Cloudflare R2) |
| `AIRINGCAL_CHECKPOINT_S3_ACCESS_KEY_ID` | Yes (GHA) | — | Bucket-scoped Writer S3 Access Key ID |
| `AIRINGCAL_CHECKPOINT_S3_SECRET_ACCESS_KEY` | Yes (GHA) | — | Bucket-scoped Writer S3 Secret Access Key |
| `AIRINGCAL_PUBLIC_S3_*` | Yes (GHA) | Same bucket/creds as checkpoint | S3 target for `public/*`, `snapshots/*`, and `images/*` in the single-bucket architecture |
| `AIRINGCAL_BUILDER_MEDIA_REFRESH` | No | `skip` (`refresh` in GHA) | When `refresh`, downloads cover images, generates `thumb.v1.webp` and `thumb.v2.webp`, and uploads missing hashes before release pointer commit |
| `BARK_URL` | No | Unset | Optional Bark push notification URL for Writer failure alerts |

---

## 5. Bounded Media Retry & Garbage Collection

- **Exponential Media Backoff**: Failed cover downloads retry with exponential backoff (`6h → 12h → 24h → 48h → 96h`, capped at 7 days). After 5 consecutive failures (`MEDIA_RETRY_LIMIT`), the subject's media row is marked `MEDIA_IMAGE_FAILED_EXHAUSTED` and parked for 30 days.
- **Snapshot & Image GC (`portable-public-gc.ts`)**:
  - Retains at least `AIRINGCAL_GC_MIN_GENERATIONS` (default `5`) and snapshots newer than `AIRINGCAL_GC_MIN_AGE_DAYS` (default `30` days), plus rollback candidates (`AIRINGCAL_GC_ROLLBACK_GENERATIONS`, default `2`).
  - Image GC (`--apply-images`) protects every image hash referenced by any retained snapshot and fails closed if any retained snapshot cannot be parsed.
