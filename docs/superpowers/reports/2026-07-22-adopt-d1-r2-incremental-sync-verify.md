---
comet_change: adopt-d1-r2-incremental-sync
role: task-11-documentation-verification
status: implemented-pending-review
verified_scope: documentation-and-config-contracts
---

# D1/R2 incremental sync documentation verification

This report verifies the Task 11 documentation boundary against implementation
at base `dc4a1928b8535c014f3493c3d12079be1714b930`. It is not Task 12 production
shadow evidence: remote migration, deployment, live metrics, and OpenSpec 6.1/6.2
remain pending for the coordinator.

## Code-backed truth table

| Contract | Current implementation | Evidence |
|---|---|---|
| Resources | D1 `airing-cal-state`, data R2 `airing-cal-data`, image R2 `airing-cal-images`, KV `airing-cal-kv`, Queue `airing-cal-media` | `scripts/cloudflare-resource-contract.mjs`; `scripts/resolve-cloudflare-resources.test.mjs` |
| Bindings | read = D1 + KV + image/data R2; sync = D1 + KV + data R2 + Queue + Workflow + SnapshotCoordinator; media = D1 + KV + image R2 + SubjectRefreshCoordinator | `apps/*/wrangler.toml`; `packages/worker-common/src/deploy-config.test.ts` |
| Runtime read boundary | read-worker handlers still use legacy KV snapshots/status and image R2; D1/data R2 bindings are unused by handlers | `apps/read-worker/src/index.ts`; `packages/worker-common/src/deploy-config.test.ts` |
| Exact schedule | `0 20 * * *`, once daily at 20:00 UTC / following 04:00 Asia/Shanghai; Cron only creates one deterministic live Workflow instance | `apps/sync-worker/wrangler.toml`; `apps/sync-worker/src/scheduled-trigger.ts` |
| D1 schema | Primary application tables: `collection_items`, `subject_media`, `sync_runs`, `sync_budget`, `app_state`; `sync_budget_reservations` is the idempotency helper; migration 0002 additively adds `sync_runs.result_json` | `migrations/0001_d1_authoritative_state.sql`; `migrations/0002_sync_run_replay_result.sql` |
| Budget | Soft 50 / hard 100; only `new_or_changed` receives privileged headroom. Current D1 invocation is shadow-only and has no Queue submitter, so its grant/submission is zero; live still uses compatibility SnapshotCoordinator budgeting | `apps/sync-worker/src/d1-sync.ts`; `apps/sync-worker/src/workflow-core.ts`; `packages/storage/src/d1-budget.test.ts` |
| Shadow authority | Only manual shadow runs D1 diff/state and data-R2 publication; missing D1/data R2 fails closed | `apps/sync-worker/src/workflow-core.ts`; `apps/sync-worker/src/workflow.test.ts` |
| Pointer/object keys | KV `public:current`; data R2 `snapshots/v1/{generation}-{content_hash}.json`; pointer contains only version/generation/hash/key/time | `apps/sync-worker/src/r2-publication.ts`; `packages/storage/src/d1-types.ts`; `packages/domain/src/public-snapshot.ts` |
| Publication recovery | D1 pending → conditional R2 PUT → R2 readback/schema/hash/key/byte verification → fenced pointer PUT → verified D1 state. Pending or ambiguous outcomes replay; previous public pointer remains available | `apps/sync-worker/src/r2-publication.ts`; `packages/storage/src/d1-state-store.test.ts` |
| Deploy order | immutable SHA validation → resolve/Cron preflight → remote D1 migration → read/media → sync/Workflow describe → frontend | `.github/workflows/deploy.yml`; `packages/worker-common/src/deploy-config.test.ts` |
| Rollback | Deploy the previous compatible full SHA; retain additive D1 migrations and all D1/R2/KV/Queue/Workflow/Durable Object state; no destructive reverse migration | `README.md`; `.github/workflows/deploy.yml` |
| Health/metrics | Public health remains a legacy-KV view and does not prove D1/data-R2 health. D1 stores bounded run fields and classified error codes; D1/R2/Queue/KV usage comes from their Cloudflare control planes | `apps/read-worker/src/index.ts`; `migrations/0001_d1_authoritative_state.sql`; `apps/sync-worker/src/d1-sync.ts` |
| Secret boundary | Public errors omit raw error text; sanitization redacts Bearer/common token values; D1 persists classified error codes; deploy failure-log output redacts Bearer header forms | `packages/worker-common/src/index.ts`; `packages/worker-common/src/errors.test.ts`; `.github/workflows/deploy.yml` |
| Later owner | Legacy import, `public:current` read cutover, and legacy KV cleanup are not part of this change and belong only to `migrate-public-reads-from-kv` | `openspec/changes/adopt-d1-r2-incremental-sync/design.md`; `openspec/changes/migrate-public-reads-from-kv/` |

## Documentation result

- `README.md` now names the exact resources, bindings, materialized ID env names,
  daily schedule, five-table model, helper table, budget boundary, pointer/object
  keys, public-read boundary, deployment order, failure recovery, health/metrics
  scope, and previous-compatible-SHA rollback.
- The 2026-06-16 single-Worker proposal is explicitly historical and starts with
  a current-state correction, so its original examples cannot be mistaken for
  an operational runbook.
- The monorepo and Free Plan Workflow designs now include the implemented
  D1/data-R2 shadow branch and exact deployment/read boundaries.
- The KV write-amplification document describes the four-hour behavior in the
  past tense and records what the D1 core superseded versus what remains the
  compatibility live path.
- `docs/rules/docs-sync.md` was not changed: Task 11 implements no new
  repository-wide durable rule beyond the existing verify-before-writing and
  documentation-sync constraints.

## Stale-claim classification

The required scan is:

```bash
rg -n '0 \*/4|every 4 hours|每 4 小时|KV.*权威|逐 subject KV|D1.*future|R2.*future|/__cron/sync' README.md docs
```

Allowed residual matches must be one of:

- explicit historical records in superseded plans/designs;
- tests/plans that forbid `0 */4` or a public `/__cron/sync`;
- explicit negative requirements such as “no per-subject KV write”.

No current runbook may instruct operators to use the four-hour schedule, a
public Cron endpoint, or D1/data R2 as the current public read source.

## Verification gates

Task 11 runs and records these gates before commit:

```bash
node --test packages/worker-common/src/deploy-config.test.ts scripts/*.test.mjs
./node_modules/.bin/openspec validate adopt-d1-r2-incremental-sync --strict
git diff --check
```

Final results:

- docs/config contract suite: **32/32 passed**;
- strict OpenSpec validation: **passed** (`Change 'adopt-d1-r2-incremental-sync' is valid`);
- `git diff --check`: **passed**;
- stale-claim scan: **passed after classification**. Remaining matches are
  historical implementation records, scan commands, explicit prohibitions of
  the old Cron endpoint/schedule, or negative requirements forbidding
  per-subject KV writes. No current runbook contains an actionable stale claim.

Task 12 package/full gates, remote migration, deployment, shadow metrics, and
OpenSpec 6.1/6.2 checkoff are deliberately not claimed here.
