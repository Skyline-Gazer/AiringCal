# EdgeOne public store (#72)

`EdgeOnePublicStore` (`packages/v3-adapters/src/edgeone-public-store.ts`) implements
the v3 `PublicStore` port over **EdgeOne Makers Blob**, so an EdgeOne Pages/Edge
Functions deployment can serve the same immutable release the Cloudflare and
Compose readers serve.

The read side is wired: `handleEdgeOneReadRequest`
(`packages/v3-read/src/edgeone-read-handler.ts`) builds the store from the bound
Blob namespace and serves the same v2 `/api/*` surface via
`handlePortableReadRequest`, labelled `platform: 'edgeone'`. Edge Functions call
it as `onRequest({ request, env })` with `env.<namespace variable name>`.

Status: adapter implemented and unit-tested against a Blob double; **no staging
run yet** (the EdgeOne Blob account is an operator/approval action), so #69's
capability rows stay candidate.

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

- Staging run on an approved EdgeOne account (bind a Blob namespace, publish a
  fixture, serve reads) → then promote the #69 matrix rows.
- Read gateway wiring for EdgeOne Edge Functions (Request/Response portability
  limits) — the CF worker entry is not reusable as-is.
- Image variants/CDN cache behavior on EdgeOne.
