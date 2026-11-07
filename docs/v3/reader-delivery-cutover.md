# Reader delivery domain cutover runbook (PR-D / P4 Task 4.4)

Owner-approved, **manual** sequence that moves the Development reader domain
`test.air.teijp.cn` from the global EdgeOne project to the new **overseas**
EdgeOne project and retires `r2.dev` as the public base. Like
[`cutover-rollback.md`](./cutover-rollback.md), **CI never runs any step here**:
no DNS record, live deploy apply, or `r2.dev` toggle is created, changed, or
deleted by a merge.

> **STATUS — Live Deployment Ready / pending Owner credentials + DNS.** Code
> adapters for Wrangler / `gh` / EdgeOne makers / Cloudflare REST are landed.
> With valid CF/GH/EO credentials + `AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes`,
> `--apply` executes real platform mutations (isolation abort still blocks copy).
> The implementing agent does not hold Owner DNS control for `test.air.teijp.cn`
> or production secrets in this environment. **No live CNAME or Staging Accepted
> receipt is claimed here.** Machine-readable status:
> [`fixtures/reader-delivery-cutover-checklist.json`](./fixtures/reader-delivery-cutover-checklist.json).

## Preconditions (all must hold before Step 1)

| Gate | How to check |
|---|---|
| Single-bucket `airingcal-development` built + isolation proven | Owner session: `AIRINGCAL_ENV=development … AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes node scripts/deploy-env.mjs --apply` exits **0** with `isolation.ok: true` (**Staging Accepted**). Without credentials/confirm the CLI stays non-mutating (`owner-gated`). `AIRINGCAL_ZONE_ID` is a required `--apply` input: the R2 custom domain attach plus the host-scoped cache rules and the WAF deny of `checkpoints/*` all key on the zone and refuse as explicit `missing-capability` (not Owner-auth pending) when it is absent — the expressions are scoped `http.host eq "<public host>"` so other sites in the same zone are untouched. R2 CORS is configured with `AllowedMethods` **GET/HEAD only**: R2 does not accept `OPTIONS` (preflight is answered by the CORS mechanism itself), and an OPTIONS entry is rejected outright.  CORS remains browser cross-origin plumbing, never access control for `checkpoints/*`. A non-zero abort with `aborted: true` means checkpoints were **not** copied — never fall back to dual buckets. |
| One effective writer only | Staging `portable-writer.yml` dispatch is blocked for the cutover window; `AIRINGCAL_WRITER_ENABLED` remains unset/false (Production gate); the Development writer test is the only `target=development` run. The freeze is lifted **only briefly inside the opt-in single-writer test** (`AIRINGCAL_DEPLOY_WRITER_TEST=yes`): `gh workflow enable` → repo variable `AIRINGCAL_DEVELOPMENT_WRITER_ENABLED=true` → `gh workflow run -f target=development` → poll to completion → **always** restore (`variable=false`, `workflow disable`) in a finally path, pass or fail. The workflow is never left enabled, and a **skipped** `development` job is a hard error (`single-writer test skipped (writer gate not visible) — not a pass`), never counted as completed. |
| Image CDN decision locked | `AIRINGCAL_IMAGE_BASE_URL` unset (reuse public base) **or** an Owner-supplied validated https host with origin Host/SNI = public R2 host and a loop check passing. Default is **off**. |

**Keep-alive guardrail:** do **not** delete `airingcal-staging-checkpoint`,
`airingcal-staging-public`, or the old `airingcal-edgeone-read` project in this
change — they are the rollback path until acceptance.

## Step 1 — Prove CF ↔ EdgeOne-overseas parity (before the CNAME)

Compare the reader surface of the Cloudflare staging host against the overseas
EdgeOne **preview** host (Owner supplies `AIRINGCAL_EDGEONE_OVERSEAS_PREVIEW_HOST`;
the preset `*.edgeone.cool` domain is access-protected, so preview through the
bound host or a valid `eo_token`/`eo_time` pair).

```bash
node scripts/reader-delivery-bench.mjs \
  --hosts https://airing-cal-v3-read-staging.r7a.workers.dev,${AIRINGCAL_EDGEONE_OVERSEAS_PREVIEW_HOST} \
  --out docs/v3/fixtures/reader-delivery-cutover-parity-pre.json
```

Gate: the receipt's `cf_vs_eo.equal` is **`true`** and the recorded
`publish.generation` + `content_hash` match on both hosts. If they differ, the
overseas project is serving a different Release — stop; re-check its
`AIRINGCAL_PUBLIC_BASE_URL` project variable and pointer freshness before
touching DNS.

## Step 2 — Point `test.air.teijp.cn` to the overseas project

Owner DNS account action:

1. In the EdgeOne console, bind `test.air.teijp.cn` to
   `airingcal-edgeone-read-overseas` and copy the target CNAME value.
2. At the DNS provider, repoint the `test` record's CNAME to that overseas
   target. Lower the record TTL first so rollback is fast.
3. **Leave `airingcal-edgeone-read` (global) deployed and unbound** — it is the
   immediate rollback if the overseas route misbehaves.

Then re-run Step 1 with `test.air.teijp.cn` in place of the preview host and
confirm `cf_vs_eo.equal` stays **`true`**:

```bash
node scripts/reader-delivery-bench.mjs \
  --hosts https://airing-cal-v3-read-staging.r7a.workers.dev,https://test.air.teijp.cn \
  --out docs/v3/fixtures/reader-delivery-cutover-parity-post.json
```

## Step 3 — Confirm the custom domain (not `r2.dev`) serves the public base

`deploy-env --apply` already disables `r2.dev` on `airingcal-development` as the
isolation precondition. This step is the reader-facing **confirmation** that, for
whatever bucket currently backs `AIRINGCAL_PUBLIC_BASE_URL`, the custom domain —
not `r2.dev` — now serves the pointer **and** one image correctly before reads
are trusted on it. If the public base was left pointing at `r2.dev` (operator set
`AIRINGCAL_PUBLIC_BASE_URL` empty to "keep the currently verified host"),
re-point it to the custom-domain CDN host and disable `r2.dev` here.

```bash
# Pointer parity (Cache-Control must be no-cache / max-age=0, not a long TTL)
curl -sfI "$AIRINGCAL_PUBLIC_BASE_URL/public/current-release.json"

# One image parity — Content-Type must be image/* (P0/P1), not application/octet-stream
curl -sfI "$AIRINGCAL_PUBLIC_BASE_URL/images/<hash>/original"

# Both 200 with the expected headers → disable the public r2.dev URL
wrangler r2 bucket dev-url disable airingcal-development -y --env-file /dev/null
```

The `<hash>` is any `images/<64-hex>/original` key referenced by the current
pointer (`portable-image-mime-repair` dry-run lists originals and their
Content-Type). If a public image still returns `application/octet-stream`
through the CDN, run the MIME repair apply and purge/refresh before declaring
parity — see [`cutover-rollback.md`](./cutover-rollback.md) for the publish/
rollback toolchain.

## Step 4 — Do **not** delete staging buckets or the old EdgeOne project

Retain `airingcal-staging-checkpoint`, `airingcal-staging-public`, and
`airingcal-edgeone-read` untouched through acceptance. Old resources are pruned
in a **separate** change after Development acceptance passes, never here.

## Rollback

| What regressed | Action |
|---|---|
| Overseas EdgeOne route (after the CNAME) | Repoint the `test` CNAME back to `airingcal-edgeone-read`; the old project is still live and serves the same Release. |
| Reader serving a bad Release | Follow pointer rollback in [`cutover-rollback.md`](./cutover-rollback.md); readers follow the pointer within the ≤ 60 s identity budget (see [`edgeone-store.md`](./edgeone-store.md)). |
| Bucket / base URL | Readers → previous staging public base. `r2.dev` can be re-enabled only as an emergency path, then re-disabled after parity. |
| Writer | Staging dispatch stays blocked until the Owner re-opens it; never run two writers during rollback. |

No Production resources are created or mutated by this runbook.

## Checklist hook (Task 5.2)

`scripts/reader-delivery-accept.mjs` MUST read
[`fixtures/reader-delivery-cutover-checklist.json`](./fixtures/reader-delivery-cutover-checklist.json)
and print every item whose `status` is not `done` under "Pending Owner items"
alongside its existing `mainland: pending_owner_node`, ICP-CDN, and
Production-apply items. The agent that performs Steps 1–3 sets each item's
`status` to `done` and fills `evidence` (bench receipt path / `cf_vs_eo`
generation+hash / `r2.dev` disable output) **only after executing it live**; an
unexecuted step stays `pending_owner`. Do not pre-mark items as done.
