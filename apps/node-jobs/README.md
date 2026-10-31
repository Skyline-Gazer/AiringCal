# @airing-cal/node-jobs

**ADR 0003 production write path:** GitHub Actions one-shot portable builder
(`.github/workflows/portable-writer.yml` → `scripts/gha-portable-writer.sh`).
Ops fill-in: [`docs/v3/gha-portable-writer.md`](../../docs/v3/gha-portable-writer.md).

`runSync()` defaults to **portable** (SQLite checkpoint → S3/filesystem
PublicStore). The legacy Cloudflare D1/KV write pipeline is opt-in only
(`AIRINGCAL_BUILDER=legacy-d1`). QingLong + `qinglong-bundle` are historical.

## Commands

```bash
pnpm -F @airing-cal/node-jobs test
pnpm -F @airing-cal/node-jobs build    # dist/qinglong-bundle/*.mjs (legacy artifact; CI still builds)
bash scripts/gha-portable-writer.sh    # from repo root (needs Checkpoint/Public S3 env)
```

## Layout

| Path | Role |
|------|------|
| `src/cli/gha-portable-writer.ts` | GHA orchestrator (lease → restore → sync → upload) |
| `src/sync/run.ts` | Sync entry (portable default / legacy-d1 opt-in) |
| `src/sync/run-portable.ts` | Portable builder sync + S3/filesystem publish |
| `src/adapters/s3-*.ts` | S3-compatible checkpoint + PublicStore |
| `scripts/build-qinglong-bundle.mjs` | Legacy QingLong esbuild entries |

Operator contract: [`docs/operator-contract.md`](docs/operator-contract.md).
