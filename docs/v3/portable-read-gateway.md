# Portable read gateway (#71)

Serves the v2-compatible public read API from a filesystem `PublicStore` root (same layout as `AIRINGCAL_BUILDER_PUBLIC_DIR` after publish).

## Run locally

```bash
export AIRINGCAL_PUBLIC_READ_DIR=./data/public-store
pnpm exec tsx packages/v3-read/src/serve-node.ts
```

Optional: `PORT` (default `8787`), `NSFW_SHOW=true|false`. When `public/manifest.json` exists, load verifies it matches the release pointer before serving. For local standalone HTTP smoke, `AIRINGCAL_BUILDER_SQLITE_PATH` may be set on the Node reader so `/api/health` can report data from `sync_runs`; this is not a supported deployment target.

Cloudflare Workers (#72): [`apps/v3-read-worker`](../../apps/v3-read-worker/README.md) builds `createCloudflareReadHandler` from `@airing-cal/v3-read/cloudflare-read-handler` over an R2 binding; staging runbook, base-URL validation and the dispatch-only staging workflow live in [`cloudflare-read-worker.md`](./cloudflare-read-worker.md). The production web-worker can serve the same surface with `AIRINGCAL_READ_MODE=v3-release` (see [`docs/reference/web-worker-public-api.md`](../reference/web-worker-public-api.md)). EdgeOne readers use the HTTPS/CDN adapter (`HttpPublicStore`) against the same public base URL — see [`edgeone-store.md`](./edgeone-store.md).

Every gateway validates `AIRINGCAL_PUBLIC_BASE_URL` when it builds its read configuration: absolute https, no query/fragment, placeholders rejected; invalid config returns **503** `INVALID_READ_CONFIG`.

`NSFW_SHOW` is resolved by one helper on every surface (`resolveNsfwShow` in `packages/v3-read/src/read-config.ts`): unset/`true` **shows** NSFW content (v2 semantics), only `false` hides it — Cloudflare, EdgeOne and the node gateway therefore answer `/api/config` identically.

## Routes

Same paths as `apps/web-worker` public reads: `/api/collections`, `/api/calendar`, `/api/config`, `/api/health`, `/api/version`, `/api/cache`, `/image/:hash`, `/image/:hash/thumb`.

Cache-Control literals match `packages/v3-core/src/read-contract.ts`.

`/image/*` redirects to the public base URL only for objects the gateway verified are present (thumb.v2 → thumb.v1, original), so a missing optional thumbnail is a plain **404** instead of a 302 to a CDN key that would 404.

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

`/health` cron is injected through `PortableReadEnv.cronStatus`: The local standalone `serve-node.ts` can pass an SQLite-backed reader; deployed stateless gateways without local SQLite omit it and report `scheduler: 'external'`.

R2 `head()` returns `etag` unquoted and `httpEtag` quoted; conditional writes must send the quoted form (`If-Match`), verified against the wrangler local R2 emulation.

Read parity across stores is guarded by `packages/v3-read/src/read-gateway-parity.test.ts`: the same published release is served by the filesystem store (portable gateway) and the R2 store (Workers gateway), and `/api/collections`, `/api/calendar`, `/api/cache`, `/api/config`, `/api/health`, `/image/:hash` and `/image/:hash/thumb` must be byte-identical (status, `Cache-Control`, `Content-Type`, body) with matching release pointers and `public/manifest.json`; `/api/version` differs only by platform identity.

## End-to-end smoke (`scripts/v3-portable-e2e.mjs`)

Seeds a synthetic release into a temp public store
(`scripts/seed-portable-fixture.ts`), boots `serve-node.ts` on a temp port, and
asserts the read surface over real HTTP — the standalone Node test server
service runs. CI runs it in the `v3_operator_smoke` job.

```bash
node scripts/v3-portable-e2e.mjs     # expected final line: {"status":"ok","stage":"v3_portable_e2e","checks":9}
```

Covered: `/api/health` (generation, `total_subjects`, `cron.scheduler`),
`/api/collections` for two types with the exact `Cache-Control` literal,
`/api/calendar`, `/api/config`, `/api/version`, `/api/sync/apply` → **410**,
`/image/:hash` → 404 for an unknown hash, and `/` loading the widget script.

### Real-browser check (executed 2026-10-17, not in CI)

A headless browser against this gateway rendered the widget end to end: the
index page loaded `AiringCal`, the frontend fetched `/api/config`, `/api/health`
and `/api/collections` (observed network sequence) and rendered
`已连接 | 条目 3`, the collection list (`中文11`, `2/12`, `SUBJECTS 3`), and —
after clicking `放送日历` — the calendar view (`六 SAT`, `中文11`, `12 话`) from
`/api/calendar`. Re-run manually with
`AIRINGCAL_PUBLIC_READ_DIR=<dir> PORT=8788 pnpm exec tsx packages/v3-read/src/serve-node.ts`.
