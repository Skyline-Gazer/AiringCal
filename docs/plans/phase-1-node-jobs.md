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

## Next

| Issue | Work |
|-------|------|
| AC-1-02 | D1 lease + Cloudflare/R2 adapters (merged) |
| AC-1-03 | Sync pipeline (`runSyncPipeline`: lease → fetch → D1 chunks → media port → R2 publish); media refresh still `noopMediaRefresh` until wired |
| AC-1-04 | Backup pipeline |
| AC-1-05 | `schema.sql` + migration docs |
| AC-1-07 | CI artifact `dist/qinglong-bundle` for QINGLONG-REPO |
| AC-1-08 | Env / timeout / exit codes doc |

QINGLONG-REPO scripts stay thin wrappers once AC-1-07 lands (blocks QL-2-01).
