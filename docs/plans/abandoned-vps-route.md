# Abandoned — VPS PostgreSQL data plane

**Decision date:** 2026-10-13  
**Owner intent:** Homelab and future writes stay on **QingLong + `apps/node-jobs` (D1/R2)**. No VPS Docker/cron path.

## What was abandoned

| Item | Action |
| --- | --- |
| `migrate-data-plane-to-vps` OpenSpec | Archived as `openspec/changes/archive/2026-10-13-abandon-migrate-data-plane-to-vps/` |
| CI job `vps-sync-image` | Removed from `.github/workflows/ci.yml` |
| `Dockerfile.vps-sync` | Removed (no maintained container image) |
| `scripts/verify-vps-sync-image.*` | Removed |

## What remains (reference only)

- `apps/vps-sync/` — TypeScript coordinator/Postgres adapters; `pnpm -F @airing-cal/vps-sync test` still runs non-integration tests.
- Historical design/runbook: `docs/superpowers/*vps*`, `docs/runbook/vps-data-plane.md` (banner: not operational).

## Active write path

See [phase-1-node-jobs.md](./phase-1-node-jobs.md) and Skyline-Gazer [QINGLONG-REPO](https://github.com/Skyline-Gazer/QINGLONG-REPO) `airingcal-sync.js`.
