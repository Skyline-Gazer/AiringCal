# Production Acceptance — Full Clean Deploy (#73)

**Authoritative Production GO/NO-GO checklist.** Development Live Acceptance ([`development-live-acceptance.md`](./development-live-acceptance.md)) does not authorize Production.

Production acceptance has separate Owner decisions for D2 Apply, D3 First Full Sync, any live rollback/roll-forward drill, and D4 traffic cutover. Record each gate and its evidence on [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73). Leave unexecuted gates pending.

Production uses one independent Cloudflare Worker, one private `airingcal-production` R2 bucket, independently scoped credentials and the GitHub `production` Environment. The Worker serves the bundled Reader/Widget, read APIs, allowlisted objects and streamed images. EdgeOne and Netlify are optional consumers. GitHub Actions is the sole Writer. The first Release comes from Bangumi Full Sync with fresh Production state.

## Acceptance order

### 1. Production identity, permissions and dry-run

Verify remote account and zone identity, R2/Worker permissions and credential scopes independently of the local dry-run. Confirm GitHub authentication, Environment availability and restrictions, both Writer gates closed and no active Writer. Validate the Production Bangumi identity, user configuration and exact clean candidate SHA before creating resources.

```bash
AIRINGCAL_ENV=production AIRINGCAL_DOTENV_PATH=.env.production \
  node scripts/deploy-env.mjs --dry-run --target cloudflare
```

Use the gitignored config from [the example](../../.env.production.example), with `AIRINGCAL_PUBLIC_BASE_URL` unset. Require `worker` mode, the independent Production Worker and `airingcal-production`, `copyFree: true`, no public R2 domain, no DNS change, no EdgeOne deploy, no existing Release adoption and both Writer gates closed. Compare the ordered plan with the authorized scope before Apply.

### 2. Create all new Production resources (Owner Apply phase)

After explicit D2 authorization, run the three-gate [deployment procedure](../DEPLOYMENT.md#deploy--production-clean-bootstrap-owner-gated) for Cloudflare only. Reuse requires an empty Production bucket after any verified isolation-probe residue is removed under the existing guard. Confirm zero R2 Custom Domains and `r2.dev` disabled. Preserve the completed-step ledger and check remote state if the current operation may have partially succeeded. Before publication, confirm the static Reader and release-dependent `503 NO_RELEASE`. Record image routing as `skipped-no-release` until D3 publishes.

### 3. Isolation probe PASS on the Production public surface

Use the Apply receipt for authenticated S3 HEAD of the temporary checkpoint probe, anonymous GET and HEAD denial through the actual Worker, and deletion verified by authenticated HEAD and a bucket re-list. Require policy denial (403/404) and accept edge 400 for malformed traversal variants only. An unrelated error or a 2xx response fails isolation. Confirm the bucket is empty again before D3.

### 4. Bangumi First Full Sync into an empty Production checkpoint

Obtain D3 authorization after gates 2 and 3. Verify the exact workflow ref and SHA, Environment restrictions, Production config, absent release/checkpoint/lease and no active Writer. Use the [dispatch and cleanup procedure](../DEPLOYMENT.md#first-data-load-production) with `.github/workflows/portable-writer.yml`, `target=production`, and `force_mode=full`. Record run ID, URL, source SHA and terminal conclusion.

The Production Environment gate is `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED`. Close it immediately after the intended Production job passes `Production bootstrap gate (fails closed)`. Keep the repository schedule gate `AIRINGCAL_WRITER_ENABLED` closed throughout. Read the published pointer, manifest, immutable snapshot, checkpoint and lease to establish the actual generation/hash, required images and fresh Bangumi lineage. On partial publication, reconcile Production state before considering recovery.

### 5. Data integrity one-shot compare vs v2 core fields

One-shot equal/diff (not a streak). Use [`shadow-gate.md`](./shadow-gate.md) / [`portable-shadow-gate`](../../apps/node-jobs/src/cli/portable-shadow-gate.ts) or `portable-snapshot-compare`:

```bash
pnpm exec tsx apps/node-jobs/src/cli/portable-shadow-gate.ts \
  --sqlite /data/builder.sqlite \
  --legacy <v2-or-legacy.json> \
  --candidate <production-public-snapshot.json>
# exit 0 = equal; exit 2 = mismatch; exit 1 = usage/IO

# alternative pure compare (no sqlite):
pnpm exec tsx apps/node-jobs/src/cli/portable-snapshot-compare.ts <left.json> <right.json>
```

PASS requires `equal: true` and `diff_count: 0` for core business fields, collections and calendar. Record both source timestamps, reconcile legitimate differences explicitly and leave missing or incomparable v2 evidence pending.

### 6. R2 checkpoint / release CAS, image completeness, MIME

- Verify Production immutable put, pointer CAS, stale `If-Match` rejection, checkpoint fencing and the single Writer authority. Use isolated verification keys where applicable and obtain specific authorization for any authoritative pointer mutation.
- Verify snapshot/manifest/pointer identity, references and content hash. Check all required originals and thumbnails for availability and correct MIME.

### 7. Cloudflare Worker live read contract

Run `node scripts/v3-ship-verify.mjs --base <production-worker-origin> --bucket airingcal-production --json` with positive private-object proof. Check deployed build identity, Reader/Widget and API compatibility, pointer/manifest/snapshot consistency, the public object allowlist, GET/HEAD, 405 plus `Allow`, deprecated sync 410, ETag and bodyless 304, exact-origin CORS/OPTIONS and streamed `200 image/*` originals and required thumbnails. Supplement verifier output with direct checks for any uncovered criterion.

### 8. Complete Bucket privacy, cache and freshness

Independently inventory `r2.dev` disabled, zero R2 Custom Domains, and no anonymous direct bucket endpoint. Confirm that images stream through the Worker and the real checkpoint exists by authenticated S3 proof while anonymous Worker GET/HEAD and encoded/traversal variants are denied. Verify immutable cache headers for content-addressed objects and the release pointer's short freshness window. Report observed CDN cache behavior only when measured.

### 9. Rollback + roll-forward drill PASS

Use [`cutover-rollback.md`](./cutover-rollback.md) and the `portable-release-rollback` receipt flow. A live drill requires two legitimate immutable Production releases and separate Owner authorization to create another generation or mutate the pointer. Close both Writer gates and confirm no active writer and a free lease. Record CAS behavior and stale-write rejection, restore the accepted pointer and verify Reader consistency and the checkpoint resume rule. A single release or an unexecuted drill leaves this gate pending.

### 10. Owner explicit GO / NO-GO before traffic switch

Owner records GO or NO-GO on #73. Keep the old system as rollback until Owner says otherwise. Traffic switch is not implied by green prep CI or Development acceptance.

## Post-cutover legacy cleanup (separate Owner operation; not bootstrap)

Legacy KV cleanup is **not** part of Production Clean Bootstrap / first Full Sync.
Keep the old system as rollback until Owner separately authorizes deletion of legacy per-subject KV keys:

```bash
pnpm exec tsx apps/node-jobs/src/cli/portable-legacy-cleanup.ts --dry-run
pnpm exec tsx apps/node-jobs/src/cli/portable-legacy-cleanup.ts --owner-approved
```

Deletes only when `migrate:read-mode.mode === 'r2'`, `public:current` is readable, **and** the explicit `--owner-approved` CLI flag. Persistent env auto-approval is not accepted. No 14-day wait.

## Historical decision (retired hard gates)

Earlier P4 text required **7 consecutive** Shadow Gate matches and a **14-day** post-cutover observation before legacy cleanup. Those calendar/run counters are **retired** as Production hard gates (ADR 0003 amendment 2026-11-08). Active acceptance is the ten gates above plus Owner GO/NO-GO. Do not treat streak=7 or fourteen-day waits as checklist items.

## Related docs

| Doc | Role |
| --- | --- |
| [`current-state.md`](./current-state.md) | Live delivery status |
| [`shadow-gate.md`](./shadow-gate.md) | One-shot parity CLI |
| [`shadow-gate-checklist.md`](./shadow-gate-checklist.md) | Operator checklist for gate 5 |
| [`cutover-rollback.md`](./cutover-rollback.md) | Cutover/rollback commands + drill |
| [`gha-portable-writer.md`](./gha-portable-writer.md) | Writer ops / Environment fill-in |
| [`reader-delivery-cutover.md`](./reader-delivery-cutover.md) | Reader parity / CDN patterns (Development reference) |

## Governance sync (#73 / Project #7)

- [Historical prep issue draft](./fixtures/issue-73-status-draft.md) retains the earlier acceptance proposal.
- [Machine-readable gates](./fixtures/production-acceptance-checklist.json) and [current state](./current-state.md) reflect the active contract and evidence state.
- Keep #73 and Project #7 in progress through bootstrap and acceptance. D4 remains a separate Owner decision.
