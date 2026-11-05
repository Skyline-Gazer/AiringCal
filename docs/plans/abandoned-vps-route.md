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
| `apps/vps-sync/` | **Removed from monorepo 2026-10-15** (git history only) |
| Actions workflow `360816866` “Publish VPS sync production image” | Still `active` on 2026-10-31, but `.github/workflows/vps-sync-image.yml` is absent from `dev` (contents API 404). The file remains on `archive/main-before-v3-alignment-20261016` (`d10d3c9b`). Disabling the registration is an owner Actions write and was not done in the 2026-10-31 reconciliation |

## Active write path

See [phase-1-node-jobs.md](./phase-1-node-jobs.md) and Skyline-Gazer [QINGLONG-REPO](https://github.com/Skyline-Gazer/QINGLONG-REPO) `airingcal-sync.js`.
