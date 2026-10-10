# Phase 1 — node-jobs + QingLong bundle

Route A: **D1 + R2** write path in `apps/node-jobs` (not `apps/vps-sync` PostgreSQL).

## Scaffold (AC-1-01)

- Package `@airing-cal/node-jobs` with `sync` / `backup` CLI entrypoints and `schema.sql` stub.
- `pnpm -F @airing-cal/node-jobs build` → `dist/qinglong-bundle/airingcal-{sync,backup}.mjs`.

## Adapters (AC-1-02)

- `readNodeJobsConfig` — `CLOUDFLARE_*`, `AIRING_CAL_D1_DATABASE_ID`, `AIRING_CAL_R2_BUCKET`, `R2_*`.
- `createCloudflareD1Client` — D1 REST `query` / `export`.
- `acquireJobLease` — `airingcal_job_leases` mutual exclusion.
- `createR2Store` — S3-compatible R2 with verified put.

## Sync orchestration (AC-1-03)

- `runSyncPipeline`: lease → fetch → D1 input chunks → media port → R2 manifest/snapshot.
- Optional `AIRING_CAL_KV_NAMESPACE_ID`: writes `public:read-mode` + `public:current` for `apps/web-worker` R2 reads.
- Media refresh remains `noopMediaRefresh` until wired from vps-sync/xyOps.

## Backup (AC-1-04)

- `runBackupPipeline`: shared lease `airingcal-data-plane` (900s) → D1 export polling → HTTPS download (≤256 MiB) → `backups/d1/<iso>-<run>.sql` on R2 with readback verify.
- Staging file under `QL_DATA_DIR` or OS temp; mode `0600`, removed after run.

## CI (AC-1-07)

- Workflow job `node-jobs-bundle`: `pnpm -F @airing-cal/node-jobs build`, verifies `dist/qinglong-bundle/*`, uploads artifact `qinglong-bundle`.

## Env template (AC-1-08)

- See [apps/node-jobs/env.example](../../apps/node-jobs/env.example).

## Remaining

| Issue | Work |
|-------|------|
| AC-1-05 | Migration apply docs for `schema.sql` |
| AC-1-06 | Integration tests (mocked CF/Bangumi) |
| Media | Replace `noopMediaRefresh` |

QINGLONG-REPO thin scripts consume the CI artifact (blocks QL-2-01).
