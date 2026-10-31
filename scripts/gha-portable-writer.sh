#!/usr/bin/env bash
# One-shot ADR 0003 portable writer entry for GitHub Actions / local ops.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="/usr/local/bin:${PATH:-}"
export AIRINGCAL_BUILDER="${AIRINGCAL_BUILDER:-portable}"
export AIRINGCAL_BUILDER_SQLITE_PATH="${AIRINGCAL_BUILDER_SQLITE_PATH:-/tmp/airingcal-builder.sqlite}"
export AIRINGCAL_BUILDER_IMAGE_DIR="${AIRINGCAL_BUILDER_IMAGE_DIR:-/tmp/airingcal-images}"
export AIRINGCAL_BUILDER_PUBLISH="${AIRINGCAL_BUILDER_PUBLISH:-true}"
export AIRINGCAL_BUILDER_MEDIA_REFRESH="${AIRINGCAL_BUILDER_MEDIA_REFRESH:-refresh}"
export AIRINGCAL_FULL_EVERY_DAYS="${AIRINGCAL_FULL_EVERY_DAYS:-7}"

exec pnpm -F @airing-cal/node-jobs exec tsx src/cli/gha-portable-writer-main.ts
