# Phase 1 — node-jobs + QingLong bundle

Route A: **D1 + R2** write path in `apps/node-jobs` (not `apps/vps-sync` PostgreSQL).

## Scaffold (AC-1-01)

- Package `@airing-cal/node-jobs` with `sync` / `backup` CLI entrypoints and `schema.sql` stub.
- `pnpm -F @airing-cal/node-jobs build` → `dist/qinglong-bundle/airingcal-{sync,backup}.mjs`.

## Next

| Issue | Work |
|-------|------|
| AC-1-02 | Port D1 lease + Cloudflare/R2 adapters |
| AC-1-03 | Sync pipeline (fetch → media → publish) |
| AC-1-04 | Backup pipeline |
| AC-1-05 | `schema.sql` + migration docs |
| AC-1-07 | CI artifact `dist/qinglong-bundle` for QINGLONG-REPO |
| AC-1-08 | Env / timeout / exit codes doc |

QINGLONG-REPO scripts stay thin wrappers once AC-1-07 lands (blocks QL-2-01).
