#!/bin/bash
set -euo pipefail

pnpm exec wrangler deploy --dry-run --outdir "apps/web-worker/dist" --config "apps/web-worker/wrangler.toml"
