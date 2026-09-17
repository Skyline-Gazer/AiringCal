#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-$SCRIPT_DIR/compose.yaml}
ENV_FILE=${ENV_FILE:-$SCRIPT_DIR/.env}
LOCK_FILE=${VPS_SYNC_LOCK_FILE:-/var/lock/airing-cal-sync.lock}
MODE=${1-shadow}

case "$MODE" in
  shadow|live) ;;
  *)
    echo "usage: $0 [shadow|live]" >&2
    exit 2
    ;;
esac

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [shadow|live]" >&2
  exit 2
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "private env file is missing; copy deploy/vps/.env.example to .env" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 127
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required" >&2
  exit 127
fi

# A busy host lock is a normal overlap skip; the PostgreSQL advisory lock remains
# the authoritative second fence once the one-shot container starts.
(
  flock -n 9 || exit 0
  exec docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm sync sync "--mode=$MODE" --source=scheduled
) 9>"$LOCK_FILE"
