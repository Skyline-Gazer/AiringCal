# EdgeOne public store (#72)

Blob is **not** a publish authority: it has no conditional write, so the release
pointer can never be moved through it safely. EdgeOne readers therefore read the
same published Release as the Cloudflare gateway, over HTTPS, from the public
base URL.

## Read path (#147 C6/C7)

`createEdgeOneReadHandler`
(`packages/v3-read/src/edgeone-read-handler.ts`) builds a read-only
`HttpPublicStore` (`packages/v3-adapters/src/http-public-store.ts`) against
`AIRINGCAL_PUBLIC_BASE_URL` and serves the v2 `/api/*` surface via
`handlePortableReadRequest`, labelled `platform: 'edgeone'`. Edge Functions call
it as `onRequest({ request, env })`.

- `HttpPublicStore.getCurrentRelease` fetches `public/current-release.json` and
  `getSnapshotBytes` fetches the referenced snapshot/manifest/image object —
  the same key layout as the R2/filesystem stores, plus the C1 `manifest_ref`
  verification done by `loadVerifiedPublicSnapshot`.
- It is read-only by construction: `commitRelease` returns `unsupported` and
  `putImmutableObject` throws.
- The base URL is validated when the handler is built (absolute https, no
  query/fragment, placeholders rejected); an invalid value fails closed as
  **503** `INVALID_READ_CONFIG`.
- When the base URL is set, `/image/:hash` 302s to `{BASE}/images/...` instead
  of proxying bytes. Optional `AIRINGCAL_IMAGE_BASE_URL` overrides that redirect
  host (`imageBaseUrl ?? publicBaseUrl`); leave it unset to keep Image CDN off.

Status: `HttpPublicStore` and the handler are unit-tested against a fake HTTPS
CDN backed by a real published R2 release, including byte parity with the
Cloudflare gateway. **No EdgeOne staging run yet**, so #69's capability rows stay
candidate.


## `EdgeOnePublicStore` (Blob adapter, not wired for reads)

`EdgeOnePublicStore` (`packages/v3-adapters/src/edgeone-public-store.ts`) keeps
implementing the `PublicStore` port over EdgeOne Makers Blob for operator/verification
tooling, but no read entry point uses it: serving from Blob would silently diverge
from the Release the writer publishes into R2/S3. It remains unit-tested against a
Blob double.

## Why Blob, not KV

Both EdgeOne storage services were checked against the official docs (2026-10-17):

| Property | EdgeOne Makers KV | EdgeOne Makers Blob |
|---|---|---|
| Key charset | numbers, letters, underscores only (≤512 B) — **no `/` or `.`** | path-like keys (`photos/cat.jpg`, `hello.txt`) |
| Value size | ≤25 MB | not documented in the same way; designed for objects |
| Read consistency | eventual (edge cache ≤60 s) | eventual by default, `{ consistency: 'strong' }` per read |
| Metadata | none | `getWithHeaders` returns headers incl. `etag`; `list` returns `{ key, etag }` |
| Conditional write (CAS) | none | none documented |

The v3 public-store key layout (`public/current-release.json`,
`snapshots/v1/<gen>-<hash>.json`, `images/<hash>/original`) is path-like, so it
cannot live in KV without a lossy key-mapping layer. Blob accepts the layout
unchanged, which also keeps cross-platform parity (see
`read-gateway-parity.test.ts` for the filesystem/R2 pair).

## Binding surface

`EdgeOneBlobBinding` is the minimal slice of `@edgeone/pages-blob`'s store the
port needs: `get(key, { type })`, `getWithHeaders(key)`, `set(key, value)` and
`list({ prefix, paginate, cursor })`. In Makers Functions the namespace is
reached through the bound variable name; from outside (node-jobs/CI) the SDK
needs `projectId` + API token — that is what a staging/verification run would use.

## Semantics and limits

- **Reads**: `getCurrentRelease` parses the pointer as text; `getSnapshotBytes`
  reads `arrayBuffer` (so image bytes and JSON snapshots share one code path).
  Strong-consistency reads are available in the SDK if a caller needs them.
- **Immutability**: `set` overwrites unconditionally, so `putImmutableObject`
  reads first, refuses different bytes, and verifies the write with a read-back;
  a concurrent publisher could still race. Publishing therefore stays
  **single-publisher** — matching `EdgeOneRuntimeAdapter`'s
  `compare_and_swap_pointer: false`.
- **Pointer commit**: `commitRelease` returns `unsupported` (the "#69 fail-closed
  without proof" rule) after confirming the expected pointer still matches, so
  the release pointer must be moved through a store with CAS
  (`CloudflareR2PublicStore`) or a serialized single-writer path.
- `listObjectKeys(prefix)` paginates the Blob cursor for GC/verification and
  rejects a repeated cursor.

## Still open

- Staging run on an approved EdgeOne account: configure
  `AIRINGCAL_PUBLIC_BASE_URL` (verified https CDN over the staging public
  bucket), deploy the template, serve reads → then promote the #69 matrix rows.
- **Deployment template** (staging-verified 2026-11-06 on project
  `airingcal-edgeone-read`): `apps/edgeone-read-worker/` provides a catch-all
  (`edge-functions/[[default]].js`) + statically emitted widget page, built by
  `pnpm -F @airing-cal/node-jobs build:edgeone-read` into
  `apps/edgeone-read-worker/dist`. Use the documented `[[default]].js` name —
  `functions/[[path]].js` is not registered as a route and 404s every path. The
  edge runtime has **no `Response.json`/`Buffer`/`process`** and a **200 ms CPU
  budget per invocation** (the read handler re-fetches pointer/snapshot/manifest
  per request unless a layer caches them).
- Read gateway wiring for EdgeOne Edge Functions (Request/Response portability
  limits) — the CF worker entry is not reusable as-is.
- Image variants/CDN cache behavior on EdgeOne.
- Pointer freshness: `HttpPublicStore` sends `cache-control: no-cache`, but the
  public bucket/CDN must not serve `public/current-release.json` with a long TTL.

## Single-bucket Development + overseas project

Development cutover (`scripts/deploy-env.mjs`) targets **one** R2 bucket
(`airingcal-development`) with key prefixes `checkpoints/**` (private),
`public/**`, `snapshots/**`, and `images/**` (public). Dual staging buckets remain
source-of-copy only and are not deleted in this change.

Readers deploy to Cloudflare plus a new EdgeOne Makers project
`airingcal-edgeone-read-overseas` (`AIRINGCAL_EDGEONE_REGION=overseas`). The
existing `airingcal-edgeone-read` project stays as rollback until domain cutover
acceptance.

**Image CDN:** `AIRINGCAL_IMAGE_BASE_URL` is optional and **off by default**.
Unset → `/image/*` redirects reuse `AIRINGCAL_PUBLIC_BASE_URL`. When set, the
deploy CLI requires https, a host different from the reader/public base (loop
rejection), and origin Host/SNI equal to the public R2 host.

**Isolation abort:** before any real checkpoint copy, deploy writes a
non-sensitive `checkpoints/_isolation-probe.txt`, then anonymous GET/HEAD of that
key on every public entrypoint must return 403/404 (`r2.dev` disabled). Any
failure **aborts cutover** — no silent dual-bucket fallback; staging readers and
writer freeze remain in place until isolation is proven.

**Domain cutover:** the manual parity → CNAME → `r2.dev`-disable sequence that
promotes `test.air.teijp.cn` to `airingcal-edgeone-read-overseas` (keeping
`airingcal-edgeone-read` as rollback) is in
[`reader-delivery-cutover.md`](./reader-delivery-cutover.md).

