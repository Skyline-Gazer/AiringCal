# Portable v3 Docker Compose

Single-user stack: **web** (read + widget), optional **scheduler** (daily incremental + periodic full reconcile), and on-demand **sync** (portable builder).

```bash
cp deploy/v3/env.example deploy/v3/.env
# optional: pnpm exec tsx apps/node-jobs/src/cli/airingcal-setup.ts docs/v3/airingcal-config.example.json --emit-env >> deploy/v3/.env
# edit .env — add BGM_TOKEN and user ids (secrets) for sync/scheduler

docker compose -f deploy/v3/docker-compose.yml up -d web
docker compose -f deploy/v3/docker-compose.yml --profile scheduler up -d scheduler
docker compose -f deploy/v3/docker-compose.yml --profile sync run --rm sync
```

Checkpoint backup (manual, WAL-safe):

```bash
docker compose -f deploy/v3/docker-compose.yml --profile sync run --rm \
  -e AIRINGCAL_BUILDER_BACKUP_DIR=/data/backups sync \
  pnpm exec tsx apps/node-jobs/src/cli/portable-checkpoint-backup.ts
```

Data volume `airingcal-data` holds `/data/public` (immutable release + images), `/data/builder.sqlite`, and optional `/data/backups`.

See also [`docs/v3/portable-read-gateway.md`](../../docs/v3/portable-read-gateway.md), [`docs/v3/airingcal-config.example.json`](../../docs/v3/airingcal-config.example.json) (v1 portable config stub for #72 setup), and [`apps/node-jobs/docs/operator-contract.md`](../../apps/node-jobs/docs/operator-contract.md).
