# apps/edgeone-read-worker

EdgeOne Pages read-gateway **template** for the v3 release contract (#72, #147).

**Status: template only — NOT deployed or staging-verified.** See
[`docs/v3/edgeone-store.md`](../../docs/v3/edgeone-store.md) for the storage
decision and what a staging run must prove before #69 matrix rows can leave
`candidate`.

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
2. Configure the Pages project variable `AIRINGCAL_PUBLIC_BASE_URL` (plus
   optional `NSFW_SHOW`, `PACKAGE_VERSION`). Never deploy `PLACEHOLDER_PUBLIC_CDN`.
3. `edgeone pages deploy` (or the EdgeOne CLI/console) for this directory.
4. Verify `/api/version` (`platform: edgeone`), `/api/health`
   (`publish.generation` matches the pointer), `/api/collections`, `/api/calendar`
   and one `/image/:hash` (302 to the CDN base).

None of this is automated by CI, and no paid resource is provisioned by any merge.
