# @airing-cal/node-jobs

GitHub Actions one-shot Portable Writer (`.github/workflows/portable-writer.yml` → `apps/node-jobs/scripts/gha-portable-writer.sh`) and maintenance CLIs for AiringCal `v3.0.0`.

- Deployment & gate operations: [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)
- Operator contract: [`docs/operator-contract.md`](docs/operator-contract.md)

## Commands

```bash
pnpm -F @airing-cal/node-jobs test
pnpm -F @airing-cal/node-jobs build    # dist/portable-bundle/{airingcal-sync,gha-portable-writer}.mjs
```

## Layout

| Path | Role |
|------|------|
| `src/cli/gha-portable-writer.ts` | GHA orchestrator (CAS lease → restore → sync → CAS checkpoint upload + lease renew → pointer commit → lease release) |
| `src/sync/run.ts` | Sync entry (`portable` builder) |
| `src/sync/run-portable.ts` | Portable builder sync + S3/filesystem publish |
| `src/adapters/s3-*.ts` | S3-compatible checkpoint + `PublicStore` adapters |
| `scripts/build-portable-bundle.mjs` | esbuild portable writer + sync entries |
