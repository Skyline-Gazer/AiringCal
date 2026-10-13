# D1 schema apply order (AC-1-05)

Apply **once per D1 database** used by node-jobs and web-worker, **before first QingLong sync**.

## Order

1. Repo migrations (authoritative app tables):

   ```bash
   # Against target D1 (wrangler or Cloudflare dashboard SQL console)
   migrations/0001_d1_authoritative_state.sql
   migrations/0002_sync_run_replay_result.sql
   ```

2. Job tables (lease, runs, staging, media cache):

   ```bash
   apps/node-jobs/schema.sql
   ```

## Verify (QingLong)

- Wrapper preflight `D1_SCHEMA_MISSING` if `airingcal_job_leases` or required app tables missing.
- Optional: `wrangler d1 execute <DB> --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`

## Tables added by `schema.sql`

| Table | Role |
| --- | --- |
| `airingcal_job_leases` | Mutex `airingcal-data-plane` (sync + backup) |
| `airingcal_job_runs` | Run metadata |
| `airingcal_job_inputs` | Chunked fetch payload per run |
| `airingcal_job_media` | Subject media refresh state |

## Idempotency

All statements use `CREATE TABLE IF NOT EXISTS`. Re-running is safe; it does not drop data.

## Reference

- Source: [`../schema.sql`](../schema.sql)
- Phase plan: [`../../../docs/plans/phase-1-node-jobs.md`](../../../docs/plans/phase-1-node-jobs.md)
