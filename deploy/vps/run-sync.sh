#!/usr/bin/env sh
set -eu

mode=${1:-live}
case "$mode" in
  live|shadow) ;;
  *) echo 'MODE_MUST_BE_LIVE_OR_SHADOW' >&2; exit 2 ;;
esac

directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image=
image_count=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    VPS_SYNC_IMAGE=*)
      image=${line#VPS_SYNC_IMAGE=}
      image_count=$((image_count + 1))
      ;;
  esac
done < "$directory/.env"

if [ "$image_count" -ne 1 ] || ! printf '%s\n' "$image" | grep -Eq '^ghcr\.io/skyline-gazer/airing-cal-sync:[0-9a-f]{40}$'; then
  echo 'VPS_SYNC_IMAGE_MUST_BE_FULL_SHA' >&2
  exit 2
fi

VPS_SYNC_IMAGE="$image" exec flock -n /tmp/airing-cal-sync.lock docker compose --env-file "$directory/.env" -f "$directory/compose.yaml" run --rm sync sync "--mode=$mode" --source=scheduled
