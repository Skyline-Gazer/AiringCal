# Portable read gateway (#71)

Serves the v2-compatible public read API from a filesystem `PublicStore` root (same layout as `AIRINGCAL_BUILDER_PUBLIC_DIR` after publish).

## Run locally

```bash
export AIRINGCAL_PUBLIC_READ_DIR=./data/public-store
pnpm exec tsx packages/v3-read/src/serve-node.ts
```

Optional: `PORT` (default `8787`), `NSFW_SHOW=true|false`.

## Routes

Same paths as `apps/web-worker` public reads: `/api/collections`, `/api/calendar`, `/api/config`, `/api/health`, `/api/version`, `/api/cache`, `/image/:hash`, `/image/:hash/thumb`.

Cache-Control literals match `packages/v3-core/src/read-contract.ts`.

## Limits (initial slice)

- No static HTML/widget bundle serving (use existing CDN or separate static host).
- `/api/cache` returns aggregate counts from snapshot `image_status` only (no KV-style item list).
- No D1/KV hydration; snapshot JSON is authoritative.
