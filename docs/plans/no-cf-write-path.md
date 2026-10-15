# No Cloudflare write path (AC-3-01)

**Decision:** Production writes **only** via QingLong + `apps/node-jobs` bundle. Cloudflare Workers do **not** run scheduled sync, Workflow, Queue consumers, or public `/api/sync/*` writes.

## Evidence

| Component | State |
| --- | --- |
| `apps/web-worker` | Read-only APIs; legacy write routes **410** |
| Legacy Workers + `vps-sync` | **Removed from repo** (2026-10-15); not deployed |
| Workers Cron / Workflow | **Not configured** for AiringCal write in production |
| `airing-cal-frontend` Cron | **None** — thumb via `POST /api/thumb-gen` only |

## Operator check

- Cloudflare dashboard: no Cron Triggers on write Workers.
- GitHub Actions: deploy workflow targets **web-worker** only (no sync-worker deploy).

## QingLong

Write cron: `airingcal-sync.js` / `airingcal-backup.js` only.
