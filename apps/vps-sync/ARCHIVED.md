# Archived — not a production write path

**Status (2026-10-13):** The VPS + PostgreSQL + Docker sync route is **abandoned**. Production writes use **Phase 1 `apps/node-jobs`** (D1 + R2) via QingLong `qinglong-bundle` CI artifact.

- Do **not** deploy `Dockerfile.vps-sync` or schedule VPS cron sync for AiringCal.
- OpenSpec change `migrate-data-plane-to-vps` is archived under `openspec/changes/archive/` with the same decision.
- Source in this package remains for reference and unit tests only; no container delivery or GHCR workflow is maintained.

See [docs/plans/phase-1-node-jobs.md](../../docs/plans/phase-1-node-jobs.md) and [docs/plans/abandoned-vps-route.md](../../docs/plans/abandoned-vps-route.md).
