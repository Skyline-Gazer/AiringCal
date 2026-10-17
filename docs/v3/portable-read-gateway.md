# Portable read gateway (#71)

Serves the v2-compatible public read API from a filesystem `PublicStore` root (same layout as `AIRINGCAL_BUILDER_PUBLIC_DIR` after publish).

## Run locally

```bash
export AIRINGCAL_PUBLIC_READ_DIR=./data/public-store
pnpm exec tsx packages/v3-read/src/serve-node.ts
```

Optional: `PORT` (default `8787`), `NSFW_SHOW=true|false`. When `public/manifest.json` exists, load verifies it matches the release pointer before serving. For Compose, set `AIRINGCAL_BUILDER_SQLITE_PATH` on the web service so `/api/health` reports scheduler cron from `sync_runs`.

Cloudflare Workers (#72): [`apps/v3-read-worker`](../../apps/v3-read-worker/README.md) wraps `handleCloudflareReadRequest` from `@airing-cal/v3-read/cloudflare-read-handler` over an R2 binding; staging runbook and emulation caveats in [`cloudflare-read-worker.md`](./cloudflare-read-worker.md). Not deployed by CI.

## Routes

Same paths as `apps/web-worker` public reads: `/api/collections`, `/api/calendar`, `/api/config`, `/api/health`, `/api/version`, `/api/cache`, `/image/:hash`, `/image/:hash/thumb`.

Cache-Control literals match `packages/v3-core/src/read-contract.ts`.

## Static frontend (v2 widget)

Same process also serves `/`, `/src/bangumi.js`, `/src/bangumi.css`, `/src/cache.js` from `@airing-cal/widget`. Deprecated sync routes return **410** like the web-worker.

## Limits (initial slice)
- `/api/cache` returns aggregate counts from snapshot `image_status` only (no KV-style item list).
- No D1/KV hydration; snapshot JSON is authoritative.

## Worker-safe entry points (#72)

Platform gateways import node-free subpaths instead of the package roots (which pull `node:http`, `node:fs`, `node:sqlite`):

| Package | Subpath | Contents |
|---|---|---|
| `@airing-cal/v3-core` | `read-contract`, `ports`, `public-pointer` | cache literals, `PublicStore` port, mutable release pointer key |
| `@airing-cal/v3-adapters` | `platform-id`, `cloudflare-r2-public-store`, `memory-r2-binding` | platform id mapping, R2 `PublicStore`, test double |
| `@airing-cal/v3-read` | `cloudflare-read-handler`, `portable-read-handler`, `portable-static-handler` | Workers gateway entry, v2 `/api/*` routes, widget + 410 sync routes |

`/health` cron is injected through `PortableReadEnv.cronStatus`: Compose web passes the SQLite-backed reader from `serve-node.ts`, gateways without local SQLite omit it and report `scheduler: 'external'`.

R2 `head()` returns `etag` unquoted and `httpEtag` quoted; conditional writes must send the quoted form (`If-Match`), verified against the wrangler local R2 emulation.

Read parity across stores is guarded by `packages/v3-read/src/read-gateway-parity.test.ts`: the same published release is served by the filesystem store (portable gateway) and the R2 store (Workers gateway), and `/api/collections`, `/api/calendar`, `/api/cache`, `/api/config`, `/api/health`, `/image/:hash` and `/image/:hash/thumb` must be byte-identical (status, `Cache-Control`, `Content-Type`, body) with matching release pointers and `public/manifest.json`; `/api/version` differs only by platform identity.
