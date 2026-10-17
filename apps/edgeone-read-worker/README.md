# apps/edgeone-read-worker

EdgeOne Pages read-gateway **template** for the v3 release contract (#72).

**Status: template only — NOT deployed or staging-verified.** EdgeOne Makers Blob
requires an operator-approved account/binding; see
[`docs/v3/edgeone-store.md`](../../docs/v3/edgeone-store.md) for the storage
decision (Blob over KV) and what a staging run must prove before #69 matrix rows
can leave `candidate`.

## What it is

A catch-all Edge Functions entry
(`functions/[[path]].js`) that:

1. resolves the bound Blob namespace (`AIRINGCAL_PUBLIC_BLOB`),
2. returns **503** `NO_PUBLIC_BLOB_BINDING` if the binding is absent (fail closed),
3. delegates to `handleEdgeOneReadRequest`
   (`@airing-cal/v3-read/edgeone-read-handler`), which serves the v2-compatible
   read surface (`/api/*`, `/image/:hash`) from the **same key layout** as the
   Cloudflare and Compose gateways.

Publishing is deliberately outside this worker: Blob has no conditional write, so
`commitRelease` reports `unsupported` — the release pointer must be moved by a
CAS-capable store or a single-writer path.

## Deploy / staging run (operator)

1. Enable EdgeOne Makers Blob (account approval), create a namespace, and bind it
   to this Pages project with a **Variable Name** matching `PUBLIC_BLOB`
   (`AIRINGCAL_PUBLIC_BLOB`).
2. Publish a release into that namespace (single-writer pointer move), e.g. from
   the operator pipeline that writes the filesystem/R2 release.
3. `edgeone pages deploy` (or the EdgeOne CLI/console) for this directory.
4. Verify against `docs/v3/edgeone-store.md`'s staging checklist (reads, and the
   fail-closed 503 without a verified pointer).

None of this is automated by CI, and no paid resource is provisioned by any merge.
