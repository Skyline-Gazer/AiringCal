# VPS sync deployment

This directory contains the manual, one-shot Compose wrapper for the VPS sync
image. It does not deploy to the VPS, publish an image, or switch the public
manifest.

## Configure the private environment

On the VPS, copy the template and keep the copy readable only by the cron user:

```sh
cp deploy/vps/.env.example deploy/vps/.env
chmod 600 deploy/vps/.env
```

Replace every placeholder. `VPS_SYNC_IMAGE` must be an existing production
image named `ghcr.io/skyline-gazer/airing-cal-sync:<40 lowercase hex SHA>`;
floating, short-SHA, and `-debug` tags are rejected by the validator. The env
file contains PostgreSQL, Bangumi, R2, and Feishu credentials; do not commit it
or pass those values on the command line.

The Compose contract is:

| Required | Optional |
| --- | --- |
| `VPS_SYNC_IMAGE`, `DATABASE_URL`, `BANGUMI_TOKEN`, `BANGUMI_USERS`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `FEISHU_WEBHOOK_URL` | `FEISHU_WEBHOOK_TOKEN`, `FEISHU_WEBHOOK_SECRET`, `FEISHU_TIMEOUT_MS` (default `10000`, max `60000`) |

The image executes only the checked-in `sync` entrypoint:
`sync --mode=shadow|live --source=scheduled|manual`. The repository also exposes
`applyMigrations(pool)`, `createBackup(deps, run)`, and
`restoreVerify(deps, key, targetUrl)` as injected APIs; `migrate`, `backup`, and
`restore-verify` are not standalone CLI commands yet. Follow the migration,
backup, restore verification, R2 key, and status contracts in
[`docs/runbook/vps-data-plane.md`](../../docs/runbook/vps-data-plane.md).

## Manual debug image

The `Publish VPS sync production image` workflow also exposes a required
`debug` boolean under `workflow_dispatch`. Run it manually with `debug` set to
`true` only when inspecting the image; it builds the Dockerfile `debug` target
and publishes `<full-git-sha>-debug`. Push events never build that target, and
the resulting tag is not a valid production Compose image.

The Compose service is one-shot and has no ports, restart policy, privileged
mode, or Docker socket. It runs as `node` with all capabilities dropped and a
read-only root filesystem. `/tmp/airing-cal` is the only writable path and is
provided as a tmpfs mount.

## Validate before the first run

From the repository root, use the template only for syntax/contract validation:

```sh
docker compose --env-file deploy/vps/.env.example -f deploy/vps/compose.yaml config
node scripts/validate-vps-compose.mjs
node --test scripts/validate-vps-compose.test.mjs
```

The rendered Compose output can contain environment values. Review it locally
and never paste it into tickets or logs. The validator becomes fail-closed for
an explicitly supplied `VPS_SYNC_IMAGE`; without that variable it checks the
checked-in structure and prints a warning.

## Local shadow run

The wrapper defaults to a scheduled shadow run and takes a non-blocking host
lock before starting the container:

```sh
VPS_SYNC_LOCK_FILE=/tmp/airing-cal-sync.lock \
  deploy/vps/run-sync.sh shadow
```

The wrapper passes only `sync --mode=shadow --source=scheduled` to the image.
Use `live` only after the explicit cutover approval and the later migration
gates; this task does not perform that switch:

```sh
VPS_SYNC_LOCK_FILE=/tmp/airing-cal-sync.lock \
  deploy/vps/run-sync.sh live
```

## Host cron

Install the cron entry as the same user that owns `.env` and the image cache.
Set the host timezone to `Asia/Shanghai`; the entry below runs at 04:00 local
time. The wrapper's `flock -n` makes an overlapping invocation exit quietly.

```cron
0 4 * * * cd /opt/airing-cal && VPS_SYNC_LOCK_FILE=/var/lock/airing-cal-sync.lock ./deploy/vps/run-sync.sh shadow >>/var/log/airing-cal-sync.log 2>&1
```

Ensure that the cron user can create `/var/lock/airing-cal-sync.lock`, or set
`VPS_SYNC_LOCK_FILE` to a writable path owned by that user. The container also
takes the PostgreSQL advisory lock; the host lock and database lock are
deliberately separate fences.
