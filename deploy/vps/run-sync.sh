#!/usr/bin/env sh
set -eu

mode=${1:-live}
case "$mode" in
  live|shadow) ;;
  *) echo 'MODE_MUST_BE_LIVE_OR_SHADOW' >&2; exit 2 ;;
esac

directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec flock -n /tmp/airing-cal-sync.lock docker compose --env-file "$directory/.env" -f "$directory/compose.yaml" run --rm sync sync "--mode=$mode" --source=scheduled
