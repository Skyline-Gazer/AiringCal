# Portable v3 Docker Compose (read / local smoke)

**ADR 0003:** production **write** scheduling is GitHub Actions
(`.github/workflows/portable-writer.yml`), not Compose. The long-running
`scheduler` service was removed. This stack remains for **local read smoke**
and optional one-shot `sync` / `gc` profiles.

```bash
cp deploy/v3/env.example deploy/v3/.env
# edit .env — optional BGM_TOKEN for profile sync

docker compose -f deploy/v3/docker-compose.yml up -d web
# optional local one-shot write (not production):
docker compose -f deploy/v3/docker-compose.yml --profile sync run --rm sync
```

Public store GC dry-run (snapshots + images plan):

```bash
docker compose -f deploy/v3/docker-compose.yml --profile gc run --rm gc
```

Destructive apply (operator-only): append `--apply` and/or `--apply-images` to the `tsx` command via `docker compose run --rm gc pnpm exec tsx apps/node-jobs/src/cli/portable-public-gc.ts --apply`.

Checkpoint backup (manual, WAL-safe) via sync profile env:

```bash
docker compose -f deploy/v3/docker-compose.yml --profile sync run --rm \
  -e AIRINGCAL_BUILDER_BACKUP_DIR=/data/backups sync \
  pnpm exec tsx apps/node-jobs/src/cli/portable-checkpoint-backup.ts
```

Data volume `airingcal-data` holds `/data/public` (immutable release + images), `/data/builder.sqlite`, and optional `/data/backups`.

Production writer ops: [`docs/v3/gha-portable-writer.md`](../../docs/v3/gha-portable-writer.md).

See also [`docs/v3/portable-read-gateway.md`](../../docs/v3/portable-read-gateway.md), [`docs/v3/airingcal-config.example.yaml`](../../docs/v3/airingcal-config.example.yaml), and [`apps/node-jobs/docs/operator-contract.md`](../../apps/node-jobs/docs/operator-contract.md).

## End-to-end check (`scripts/v3-compose-e2e.mjs`)

Builds the image, seeds a synthetic release into the `airingcal-data` volume,
runs `compose up -d web`, asserts the read surface over the published port, and
always tears down with `compose down -v`. CI runs it as the `v3_compose_e2e`
job; locally it needs a working Docker daemon:

```bash
node scripts/v3-compose-e2e.mjs
V3_COMPOSE_E2E_PORT=8790 node scripts/v3-compose-e2e.mjs   # override port
```
