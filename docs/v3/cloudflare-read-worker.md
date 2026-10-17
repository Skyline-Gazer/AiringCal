# Cloudflare read worker (#72)

`apps/v3-read-worker` is the Cloudflare Workers entry that serves the v2 read
surface from the immutable v3 public store in R2. Status: **staging only** — CI
does not deploy it, and no production cutover happens before #73 DoD.

## Surface

| Route | Behaviour |
|---|---|
| `GET /`, `/src/bangumi.js`, `/src/bangumi.css`, `/src/cache.js` | Widget assets (`@airing-cal/widget`) |
| `GET /api/sync/apply`, `/api/sync/compare`, `/api/check/*` | **410** `DEPRECATED`, `Cache-Control: no-store` |
| `GET /api/version` | `read`/`platform` = `cloudflare`; `package` from the `PACKAGE_VERSION` var |
| `GET /api/config`, `/api/collections`, `/api/calendar`, `/api/cache`, `/api/health` | v2 JSON shapes and `Cache-Control` literals from `@airing-cal/v3-core/read-contract` |
| `GET /image/:hash`, `/image/:hash/thumb` | Original / thumb v2 → v1 key fallback, immutable cache headers |

`/api/health` reports `cron.scheduler: 'external'` — a Worker has no local
SQLite, so the Compose scheduler status is not available (contrast the Compose
web service, which injects a SQLite-backed provider).

Fail-closed behaviour: a missing/misnamed `AIRINGCAL_PUBLIC_R2` binding returns
**503** `NO_PUBLIC_STORE_BINDING` (not a 500 stack), and a `head()` result
without a usable quoted `httpEtag` throws instead of sending `If-Match: undefined`.

## R2 binding contract

```toml
[[r2_buckets]]
binding = "AIRINGCAL_PUBLIC_R2"
bucket_name = "airing-cal-public"
```

`CloudflareR2BucketBinding` requires only `get`, `head`, `put`; the real
`R2Bucket` binding satisfies it.

Measured against the wrangler local R2 emulation (workerd/miniflare, probe run
2026-10-17):

| Observation | Result |
|---|---|
| `head(key)` fields | `etag` unquoted (`6654c7…`), `httpEtag` quoted (`"6654c7…"`) |
| `put(..., { onlyIf: If-Match: <unquoted etag> })` | **throws** `Invalid ETag in if-match header` |
| `put(..., { onlyIf: If-Match: <httpEtag> })` | accepted |
| `put(..., { onlyIf: If-Match: <stale etag> })` | accepted — **precondition not enforced locally** |
| `put(..., { onlyIf: If-None-Match: '*' })` on an existing key | accepted — **precondition not enforced locally** |

Consequences:

- The release pointer CAS must send `httpEtag`; sending `etag` fails on any R2
  implementation that validates the header (fixed in #108,
  `CloudflareR2PublicStore.commitRelease`).
- Immutability and CAS guarantees **cannot be verified locally**; the local
  emulation overwrites violating puts. A real-bucket check is still required
  before trusting the publish path in production.

## Local staging smoke (no remote resources)

```bash
pnpm exec tsx apps/v3-read-worker/scripts/staging-smoke.ts
```

Steps: publish a builder checkpoint to a temp public dir → seed the local R2
emulation with `wrangler r2 object put --local` → start `wrangler dev -l` →
assert the HTTP surface → tear down. Expected final line:

```json
{"status":"ok","stage":"v3_cf_read_smoke","checks":8}
```

CI runs this in the `v3_operator_smoke` job.

## Real-cloudflare staging checklist (owner, manual)

1. Create/reuse a **non-production** bucket and point `bucket_name` at it.
2. Publish a checkpoint with the operator path (`airingcal-config` /
   `publishBuilderCheckpoint`) so `public/current-release.json`,
   `public/manifest.json`, and `snapshots/v1/*` exist in the bucket.
3. `wrangler deploy --config apps/v3-read-worker/wrangler.toml`, then check
   `/api/health` (`publish.generation`), `/api/collections`, and one `/image/:hash`.
4. Verify publisher safety on the real bucket: a repeated immutable put must be a
   no-op, a changed body must be rejected, and a stale `If-Match` pointer commit
   must return a conflict.
5. Record results in the #69 capability matrix (rows stay *candidate* until then).

## Still open

- Real-bucket precondition verification (above) and #69 anonymized production sizing.
- EdgeOne adapter/store (no `EdgeOne*PublicStore` yet).
- Operator `airingcal.yaml` setup wiring for bucket names and deploy targets (#72).
- Frontend parity E2E and the legacy sync tab (returns 410 since v2).
