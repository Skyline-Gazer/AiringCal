# apps/edgeone-read-worker

EdgeOne Pages read-gateway **template** for the v3 release contract (#72, #147).

**Status: deployed to EdgeOne Makers and staging-verified (2026-11-06).** Project
`airingcal-edgeone-read` (`makers-bj3mt2hqynok`, global), serving the same
published Release as the Cloudflare gateway. The preset `*.edgeone.cool` domain
requires a bound public domain (or a valid `eo_token`/`eo_time` pair) because it
enforces platform access protection. See
[`docs/v3/edgeone-store.md`](../../docs/v3/edgeone-store.md) for the storage
decision and what a staging run must prove.

**Build the deployable artifact** (workspace imports and `Response.json` are not
available in EdgeOne's V8 runtime, so the function is bundled to one file):

```bash
pnpm -F @airing-cal/node-jobs build:edgeone-read   # -> apps/edgeone-read-worker/dist/functions/[[path]].js
pnpm -F @airing-cal/node-jobs build:edgeone-read && \
  edgeone makers deploy apps/edgeone-read-worker/dist -n airingcal-edgeone-read
```

Set the project variable `AIRINGCAL_PUBLIC_BASE_URL` (absolute https) first;
deploying a new artifact takes about 1–2 minutes to propagate to the domain.

## What it is

A catch-all Edge Functions entry (`functions/[[path]].js`) that:

1. reads `AIRINGCAL_PUBLIC_BASE_URL` from the Pages project variables,
2. fails closed with **503** `INVALID_READ_CONFIG` when it is missing, non-https
   or a placeholder (validated once per isolate),
3. delegates to `createEdgeOneReadHandler`
   (`@airing-cal/v3-read/edgeone-read-handler`), which serves the v2-compatible
   read surface (`/api/*`, `/image/:hash`) from the **same published Release** as
   the Cloudflare gateway, fetched over HTTPS via `HttpPublicStore`
   (`@airing-cal/v3-adapters/http-public-store`).

Blob is intentionally not on the read path: Makers Blob has no conditional
write, so it never receives the release pointer and would silently diverge from
the Release the GHA writer publishes into R2/S3.

## Deploy / staging run (operator)

1. Publish a staging Release into the staging public bucket (R2/S3) and front it
   with a verified https CDN base URL.
2. Configure the project variable with
   `edgeone makers env set AIRINGCAL_PUBLIC_BASE_URL <https-url> -e production`
   (plus optional `NSFW_SHOW`, `PACKAGE_VERSION`). Never deploy `PLACEHOLDER_PUBLIC_CDN`.
3. Build the bundle (`pnpm -F @airing-cal/node-jobs build:edgeone-read`) and
   deploy `apps/edgeone-read-worker/dist` with `edgeone makers deploy`.
4. Verify `/api/version` (`platform: edgeone`), `/api/health`
   (`publish.generation` matches the pointer), `/api/collections`, `/api/calendar`
   and one `/image/:hash` (302 to the CDN base).

Runtime constraints confirmed by a deployed probe: the V8 isolate provides
`fetch`, `Request`/`Response`, `TextEncoder`/`TextDecoder`, `URL`, `crypto.subtle`
and `setTimeout`, but **no `Response.json`**, `Buffer` or `process`. JSON responses
are therefore constructed explicitly in `@airing-cal/v3-read`.

Deployment is manual (no CI step), and no paid resource is provisioned by any merge.
