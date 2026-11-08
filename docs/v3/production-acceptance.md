# Production Acceptance — Full Clean Deploy (#73)

**Authoritative Production GO/NO-GO checklist.** Development Live Acceptance ([`development-live-acceptance.md`](./development-live-acceptance.md)) does not authorize Production.

> **This prep change set does not authorize Production Apply, `main` cutover, or enabling `AIRINGCAL_WRITER_ENABLED`.** Gates 2–4 and traffic switch are Owner-executed after separate authorization. Prep proves dry-run plan shape, one-shot parity tooling, and docs only.

Topology: one new bucket `airingcal-production` (prefixes `checkpoints/**`, `public/**`, `snapshots/**`, `images/**`); independent `.env.production`, CF Worker, EdgeOne overseas project, GitHub `production` Environment; first Release from Bangumi Full Sync into an empty checkpoint (no Development/Staging/v2 object copy).

## Acceptance order (encode exactly)

Complete in order. Each gate is PASS / FAIL / blocked_not_authorized. Owner records evidence on [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73).

### 1. Production Preflight identity / token / zone / domain / Git SHA

Dry-run plan must PASS (no cloud mutations).

```bash
# fill Owner placeholders in a gitignored sibling of the example
cp .env.production.example .env.production
AIRINGCAL_DOTENV_PATH=.env.production AIRINGCAL_ENV=production \
  node scripts/deploy-env.mjs --dry-run
```

Expect: plan `bucket: airingcal-production`, clean-bootstrap steps (including `preflight-identity`, `ensure-bucket-airingcal-production`, `isolation-probe`), **no** `copy-*` steps, `writerEnabled: false`.

Without `AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes`, `--apply --i-am-sure-production` must still refuse mutations (exit non-zero).

### 2. Create all new Production resources (Owner Apply phase)

Future Owner Apply only — empty `airingcal-production`, GitHub Environment `production`, Production CF Worker, EdgeOne overseas project. Names must not collide with Development/Staging/v2. Not authorized in this prep.

### 3. Isolation probe PASS on Production public host

Anonymous `GET`/`HEAD` of a checkpoint probe on the Production public host must be **403** before any writer publish (plan step `isolation-probe`). Mirror Development evidence pattern in [`development-live-acceptance.md`](./development-live-acceptance.md).

### 4. Bangumi first Full Sync into empty checkpoint (Owner Apply phase)

Owner enables the Production Writer gate only under separate authorization, then dispatches:

- Workflow: `.github/workflows/portable-writer.yml`
- `workflow_dispatch` **target=`production`**, **`force_mode=full`**

First Production Release must come from Bangumi Full Sync into the fresh SQLite checkpoint/lease/release — not imported Development checkpoint bytes. Scoped v2 field import only if a field is proven non-rebuildable ([`legacy-state-import.md`](./legacy-state-import.md)).

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

PASS when `equal: true` / `diff_count: 0` for core business fields / collections / calendar.

### 6. R2 checkpoint / release CAS, image completeness, MIME

- Immutable put / pointer CAS / stale `If-Match` conflict behavior on `airingcal-production`
- Image completeness for the current pointer (originals + required thumbs readable)
- MIME verification / repair as needed (`portable-image-mime-repair` pattern from Development)

### 7. Cloudflare / EdgeOne Reader API + generation + image 302 parity

Both Production readers must agree on generation / content hash; `GET /image/<hash>` → 302 to the Production public image URL. Reuse reader parity / bench tooling documented in [`reader-delivery-cutover.md`](./reader-delivery-cutover.md) and `scripts/reader-delivery-accept.mjs` (Development compose; Production hosts/credentials).

### 8. CDN / WAF checkpoint deny + cache correctness

Host-scoped WAF deny on `checkpoints/**`, cache rules for `/images/` + `/snapshots/` and pointer bypass — same contract as Development, Production public host only.

### 9. Rollback + roll-forward drill PASS

Reuse [`cutover-rollback.md`](./cutover-rollback.md) `portable-release-rollback` receipt flow (dry-run then Owner `--apply --writer-frozen` under freeze). Confirm roll-forward / resume rule before re-enabling Writer.

### 10. Owner explicit GO / NO-GO before traffic switch

Owner records GO or NO-GO on #73. Keep the old system as rollback until Owner says otherwise. Traffic switch is not implied by green prep CI or Development acceptance.

## Post-cutover legacy cleanup (not a day timer)

After reads are on R2 and Owner approves deletion of legacy per-subject KV keys:

```bash
pnpm exec tsx apps/node-jobs/src/cli/portable-legacy-cleanup.ts --dry-run
pnpm exec tsx apps/node-jobs/src/cli/portable-legacy-cleanup.ts --owner-approved
# or AIRINGCAL_LEGACY_CLEANUP_OWNER_APPROVED=true
```

Deletes only when `migrate:read-mode.mode === 'r2'`, `public:current` is readable, **and** explicit Owner approval. No 14-day wait.

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
