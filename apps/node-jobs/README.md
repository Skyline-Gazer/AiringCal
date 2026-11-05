# @airing-cal/node-jobs

**ADR 0003 production write path:** GitHub Actions one-shot portable builder
(`.github/workflows/portable-writer.yml` → `scripts/gha-portable-writer.sh`).
Ops fill-in: [`docs/v3/gha-portable-writer.md`](../../docs/v3/gha-portable-writer.md).

`runSync()` is **portable-only**. `AIRINGCAL_BUILDER=legacy-d1` fails closed.
Legacy D1 adapters may still exist for migration CLIs (`portable-legacy-*`), not
for production sync.

## Commands

```bash
pnpm -F @airing-cal/node-jobs test
pnpm -F @airing-cal/node-jobs build    # dist/portable-bundle/{airingcal-sync,gha-portable-writer}.mjs
bash scripts/gha-portable-writer.sh    # from repo root (needs Checkpoint/Public S3 env)
```

## Layout

| Path | Role |
|------|------|
| `src/cli/gha-portable-writer.ts` | GHA orchestrator (lease → restore → sync → upload) |
| `src/sync/run.ts` | Sync entry (portable only) |
| `src/sync/run-portable.ts` | Portable builder sync + S3/filesystem publish |
| `src/adapters/s3-*.ts` | S3-compatible checkpoint + PublicStore |
| `scripts/build-portable-bundle.mjs` | esbuild portable writer + sync entries |

Operator contract: [`docs/operator-contract.md`](docs/operator-contract.md).
