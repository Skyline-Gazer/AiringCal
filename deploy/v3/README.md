# Portable v3 Docker Compose

Single-user stack: **web** (read + widget) and on-demand **sync** (portable builder).

```bash
cp deploy/v3/env.example deploy/v3/.env
# edit .env — BGM_TOKEN and user ids required for sync

docker compose -f deploy/v3/docker-compose.yml up -d web
docker compose -f deploy/v3/docker-compose.yml --profile sync run --rm sync
```

Data volume `airingcal-data` holds `/data/public` (immutable release + images) and `/data/builder.sqlite`.

See also [`docs/v3/portable-read-gateway.md`](../../docs/v3/portable-read-gateway.md) and [`apps/node-jobs/docs/operator-contract.md`](../../apps/node-jobs/docs/operator-contract.md).
