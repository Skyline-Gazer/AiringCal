#!/bin/bash
set -euo pipefail

for app in frontend-worker read-worker sync-worker media-worker; do
  pnpm exec wrangler deploy --dry-run --outdir "apps/$app/dist" --config "apps/$app/wrangler.toml"
done
