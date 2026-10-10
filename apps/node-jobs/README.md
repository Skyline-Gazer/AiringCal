# @airing-cal/node-jobs

Scheduled **sync** and **backup** for the D1 + R2 data plane (Route A). QingLong runs the bundled scripts from `dist/qinglong-bundle/`; logic lives here, not in QINGLONG-REPO.

## Commands

```bash
pnpm -F @airing-cal/node-jobs test
pnpm -F @airing-cal/node-jobs build    # dist/qinglong-bundle/*.mjs
```

## Layout

| Path | Role |
|------|------|
| `src/sync/run.ts` | Sync orchestration (fetch → media → publish) |
| `src/backup/run.ts` | D1 export → private R2 |
| `schema.sql` | D1 additions for job lease/state (apply before first run) |
| `scripts/build-qinglong-bundle.mjs` | esbuild entries for QingLong |

Phase 1 issues: Project #5 AC-1-*.
