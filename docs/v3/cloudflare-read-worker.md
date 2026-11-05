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

### web-worker parity mode (#147 C7)

`apps/web-worker` does **not** ship this binding yet: adding it to the production
config would make `wrangler deploy` depend on the v3 public bucket existing, which
is an owner cutover decision. To enable `AIRINGCAL_READ_MODE=v3-release`, add the
same block to `apps/web-worker/wrangler.toml` (plus the runtime var), run
`pnpm -F @airing-cal/web-worker cf:types`, and deploy:

```toml
# C7: public Release store for AIRINGCAL_READ_MODE=v3-release (default stays legacy).
[[r2_buckets]]
binding = "AIRINGCAL_PUBLIC_R2"
bucket_name = "airing-cal-public"
```

Pointer validation and CAS identity (`parsePublicReleasePointer`, `releasePointersMatch`, `bytesEqual`) live in `@airing-cal/v3-core/public-pointer` and are shared by the filesystem and R2 stores.

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

`V3_READ_SMOKE_PORT` overrides the dev-server port (default `8799`); the seed step asserts `wrangler.toml` declares the bucket it writes to.

## `AIRINGCAL_PUBLIC_BASE_URL` (C6)

`createCloudflareReadHandler` accepts the raw `AIRINGCAL_PUBLIC_BASE_URL` and
validates it **when the read configuration is built** (first data request per
isolate, memoized):

- absolute `https` only (loopback `http` is allowed only inside the
  `HttpPublicStore` test/local adapter);
- no query or fragment;
- placeholder hosts (`https://PLACEHOLDER_PUBLIC_CDN`, …) are rejected.

A bad value fails closed as **503** `INVALID_READ_CONFIG` with the variable name
and reason — never as a per-request image error and never as a silent fallback.
When the value is valid, `/image/:hash` 302s to `{BASE}/images/...`; when unset,
image bytes are proxied from the R2 public store.

## Staging deploy workflow (C8, #147)

`.github/workflows/v3-read-worker-staging.yml` deploys this Worker to the
**staging** Environment:

- `workflow_dispatch` only — no `push`, `pull_request` or `schedule` trigger;
- first step validates required staging config and `exit 1`s before checkout;
- only `AIRINGCAL_STAGING_*` secrets/vars are expanded
  (`AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN`,
  `AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID`,
  `AIRINGCAL_STAGING_WORKER_NAME`, `AIRINGCAL_STAGING_PUBLIC_R2_BUCKET`,
  `AIRINGCAL_STAGING_PUBLIC_BASE_URL`);
- `scripts/materialize-v3-read-staging-config.mjs` rewrites the
  `AIRINGCAL_PUBLIC_R2` bucket to the staging bucket, rejects the production
  bucket, injects the verified base URL/sha as vars, and writes a temp config;
- `wrangler deploy` only ever sees that materialized config, so a staging run
  cannot read the production Release.

## Real-cloudflare staging checklist (owner, manual)

1. Create a **staging-only** public bucket and pre-create the staging
   Environment secrets/vars listed above (`AIRINGCAL_STAGING_*`). Never point the
   staging workflow at the production bucket or production credentials.
2. Publish a checkpoint with the operator path (`airingcal-config` /
   `publishBuilderCheckpoint`) into that bucket so `public/current-release.json`,
   the generation-scoped `public/manifests/*` object, and `snapshots/v1/*` exist.
3. Dispatch `v3 read worker (staging)` (or run `wrangler deploy` locally), then
   check `/api/health` (`publish.generation`), `/api/collections`, and one
   `/image/:hash`.
4. Verify publisher safety on the real bucket: a repeated immutable put must be a
   no-op, a changed body must be rejected, and a stale `If-Match` pointer commit
   must return a conflict.
5. Record results in the #69/#147 capability matrix (rows stay *candidate* until
   then).

## Still open

- Real-bucket precondition verification (above). **Production anonymized sizing:** done via manual workflow `sizing-probe.yml` (run `39052596856`, 2026-10-17) — gzip **110 769** B, generation **15**, `single_json_viable: true` (counts only; see `p0-contract-evidence.md`).
- EdgeOne staging run over the same Release (`HttpPublicStore` reads the public
  base URL; no approved EdgeOne account yet — see `edgeone-store.md`).
- Operator `airingcal.yaml` setup wiring for bucket names and deploy targets (#72).
- Frontend parity E2E and the legacy sync tab (returns 410 since v2).
