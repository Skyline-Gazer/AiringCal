# No Cloudflare write path (AC-3-01)

**Decision (updated ADR 0003):** Production writes via **GitHub Actions** portable
one-shot (`apps/node-jobs` + S3). QingLong + `qinglong-bundle` are retired as the
live writer. Cloudflare Workers do **not** run scheduled sync, Workflow, Queue
consumers, or public `/api/sync/*` writes.

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

## Writer (ADR 0003)

GitHub Actions: `.github/workflows/portable-writer.yml` → `scripts/gha-portable-writer.sh`.
Ops: `docs/v3/gha-portable-writer.md`. Historical QingLong wrappers remain in
QINGLONG-REPO for archive only.
