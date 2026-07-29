---
comet_change: adopt-d1-r2-incremental-sync
role: task-12-verification-ready
status: local-evidence-ready-pending-independent-review-and-production
verified_scope: full-local-gates-materialized-dry-runs-media-projection-schedule-watermark
verified_source_sha: ff999c0d5d21bbf450d1315c8b440182b79948c7
---

# D1/R2 incremental sync verification-ready evidence

This report records current local evidence for runtime source SHA
`ff999c0d5d21bbf450d1315c8b440182b79948c7`. The evidence-report update after
that commit contains no runtime or configuration change, so this remains the
exact implementation reviewed by the gates below.

This is deliberately not production evidence. No remote D1 migration, merge to
`dev`, Worker deployment, production Workflow run, live metric query, public
smoke test, or Comet `verify` transition was performed. OpenSpec 6.1 and 6.2
remain unchecked for coordinator review and production integration.

## Fresh local gates

The installed CLIs were checked before use:

- `pnpm exec wrangler deploy --help` confirms `--dry-run`, `--outdir`, and
  `--config`;
- `./node_modules/.bin/openspec validate --help` confirms `--strict`.

| Command | Result | Exact evidence |
|---|---|---|
| `pnpm test` | PASS | 529/529 tests, 0 failed |
| `pnpm typecheck` | PASS | all 9 workspace projects completed |
| `pnpm build:check` | PASS | frontend/read/media/sync types current and dry-runs completed |
| `./node_modules/.bin/openspec validate adopt-d1-r2-incremental-sync --strict` | PASS | `Change 'adopt-d1-r2-incremental-sync' is valid` |
| `git diff --check` | PASS | no output |
| focused media projection, schedule, compatibility, and fence command listed below | PASS | 134/134 tests, 0 failed |

Wrangler's default macOS debug-log directory is outside this worktree sandbox.
Source inspection of installed Wrangler 4.100.0 confirmed
`WRANGLER_LOG_PATH`; the fresh gate ran as
`WRANGLER_LOG_PATH=/tmp/bangumitv-media-projection-build-logs pnpm build:check` and
completed cleanly.

### Full test count

| Suite | Passed |
|---|---:|
| `@airing-cal/widget` | 26 |
| `@airing-cal/worker-common` | 13 |
| `@airing-cal/storage` | 87 |
| `@airing-cal/domain` | 67 |
| `@airing-cal/bgm-api` | 28 |
| `@airing-cal/frontend-worker` | 7 |
| `@airing-cal/read-worker` | 33 |
| `@airing-cal/sync-worker` | 190 |
| `@airing-cal/media-worker` | 55 |
| root script tests | 23 |
| **Total** | **529** |

Package counts that were not visible in the terminal's truncated full-run
stream were confirmed with Node's native test runner plus the installed `tsx`
loader; those count checks also passed.

### Focused acceptance command

```bash
node --import tsx --test \
  packages/storage/src/media-job.test.ts \
  packages/storage/src/d1-budget.test.ts \
  apps/media-worker/src/media-worker.test.ts \
  apps/media-worker/src/subject-refresh-coordinator.test.ts \
  apps/media-worker/src/d1-media-state.test.ts \
  apps/sync-worker/src/d1-sync.test.ts \
  apps/sync-worker/src/snapshot-coordinator.test.ts \
  apps/sync-worker/src/workflow.test.ts
```

Result: **134/134 passed, 0 failed**.

## Materialized Wrangler verification

Temporary configs used only canonical fake identifiers:

- D1 database ID:
  `11111111-1111-4111-8111-111111111111`;
- KV namespace ID:
  `11111111111111111111111111111111`;
- frontend build SHA:
  `ff999c0d5d21bbf450d1315c8b440182b79948c7`.

Read, Media, and Sync were materialized with resource IDs only, matching their
deploy jobs. Frontend was materialized with build metadata, matching its
separate deploy job. An executable assertion rejected unresolved
`<PLACEHOLDER>`-style values and checked both required and forbidden bindings.

| Config | Asserted materialized matrix | Dry-run |
|---|---|---|
| Read | D1 + legacy KV + image R2 + data R2; no Queue/Workflow/DO | PASS, 22.91 KiB / gzip 6.15 KiB |
| Media | D1 + legacy KV compatibility + image R2 + Queue consumer + `SubjectRefreshCoordinator`; no data R2/Workflow | PASS, 112.28 KiB / gzip 21.82 KiB |
| Sync | `SyncWorkflow` + D1 + data R2 + legacy KV compatibility + media Queue producer + `SnapshotCoordinator`; no image R2/Queue consumer | PASS, 229.63 KiB / gzip 46.46 KiB |
| Frontend | Read and Sync service bindings plus build metadata only | PASS, 69.36 KiB / gzip 16.65 KiB |

The four exact materialized configs all passed:

```bash
pnpm exec wrangler deploy --dry-run \
  --outdir /tmp/bangumitv-media-projection.uiRwwv/dist-<app> \
  --config /tmp/bangumitv-media-projection.uiRwwv/wrangler-<app>.toml
```

Only Frontend received `BANGUMI_GIT_*` variables, matching their scope in
`.github/workflows/deploy.yml`; Read, Media, and Sync received resource IDs
only.

## OpenSpec requirement audit

Every added requirement was checked against implementation and an executable
test. The result is **16/16 locally approved**.

| OpenSpec requirement | Authoritative source | Fresh executable evidence | Result |
|---|---|---|---|
| State resources are replay-safe to bootstrap | `scripts/cloudflare-resource-contract.mjs`; `scripts/provision-cloudflare-resources.mjs` | provision tests create once, reuse D1 ID, re-list races, and replay later pages/cursors | PASS |
| D1 migration precedes Worker upload | `.github/workflows/deploy.yml` | deploy-config test reconstructs `resolve → migration → read/media → sync → frontend` dependencies | PASS |
| Missing resources fail before upload | `scripts/resolve-cloudflare-resources.mjs` | resolver tests cover missing D1, KV, data R2, image R2, and Queue | PASS |
| D1 stores mutable authoritative state | `migrations/0001_d1_authoritative_state.sql`; `packages/storage/src/d1-state-store.ts` | migration/schema and typed state-store tests in the 524-test gate | PASS |
| Collection diff ignores runtime fields | `packages/storage/src/canonical-json.ts`; `packages/domain/src/collection-diff.ts` | canonical hash excludes observation fields; later identical observation plans zero writes | PASS |
| Deletion requires two successful complete reads | `packages/domain/src/collection-diff.ts` | first/second missing, same-run replay, incomplete input, and vanished staged page tests | PASS |
| QoS budget reservation is atomic | `packages/storage/src/d1-budget.ts` | final-slot concurrency, stable reservation replay, and hard-limit tests | PASS |
| Workflow incrementally commits D1 | `apps/sync-worker/src/d1-sync.ts` | unchanged writes zero rows, one change writes one, replay avoids a second mutation, lifecycle counters persist | PASS |
| Workflow publishes a verifiable R2 candidate | `apps/sync-worker/src/workflow-core.ts`; `apps/sync-worker/src/d1-sync.ts`; `apps/sync-worker/src/r2-publication.ts` | D1-before-publication integration, next-day media projection/hash change, frozen checkpoint replay, and changed/no-op/failure publication tests | PASS |
| Subject media authority is D1 and new flow avoids subject KV | `apps/media-worker/src/d1-media-state.ts`; `apps/media-worker/src/index.ts` | not-due semantic no-op is zero D1/R2 writes; due semantic no-op advances only schedule watermarks; D1-only V4 Queue/direct/DO paths perform no legacy per-subject puts | PASS |
| Cold media rotates across seven days | `apps/sync-worker/src/refresh-planner.ts` | all seven residues selected exactly once and D1 orchestration exercises seven UTC shards | PASS |
| Public snapshot is one immutable object | `packages/domain/src/public-snapshot.ts`; `apps/sync-worker/src/r2-publication.ts` | exact content-addressed key plus changed publication ordering test | PASS |
| Unchanged public content performs zero publication writes | `apps/sync-worker/src/r2-publication.ts` | identical verified content allocates no generation and performs zero R2/KV writes | PASS |
| Pointer switches last | `apps/sync-worker/src/r2-publication.ts` | event-order test and D1/R2/readback/KV injected failures preserve the prior pointer | PASS |
| D1/R2 publication is automatically verified | `.github/workflows/ci.yml`; package test scripts | full 529/529 gate plus focused 134/134 media projection, schedule, compatibility, and fence gate | PASS |
| Deploy config resolves all state resources | `scripts/materialize-wrangler-config.mjs`; Worker TOMLs; deploy workflow | no-placeholder matrix assertion plus four materialized Wrangler dry-runs | PASS |

## Design §10 acceptance audit

The result is **8/8 locally approved**.

| Criterion | Evidence | Result |
|---|---|---|
| Identical complete input: collection 0 writes, data R2 0 PUT, generation unchanged, `public:current` 0 PUT | `d1-sync.test.ts`: unchanged input and response-loss replay; `d1-state-store.test.ts`: unchanged plan/replayed transition zero writes; `r2-publication.test.ts`: unchanged before allocation/R2/KV | PASS |
| Rate, tags, comment, collection status, episode and volume progress change without depending on `updated_at` | collection-diff business-field matrix changes each field independently while the fixture timestamp remains constant and plans exactly one update | PASS |
| First missing is retained; only a later complete miss deletes; partial/failed pages never advance deletion | domain, D1 orchestration, and staged-page disappearance tests | PASS |
| Daily media grant stays `<= 100` under concurrency and replay | D1 final-slot concurrency and replay tests; coordinator concurrent/replayed hard-limit tests; Workflow hard-limited counter test | PASS |
| New media flow writes no per-subject legacy KV | V4 no-D1 fail-closed, D1-only Queue/direct/DO, due schedule-only D1 mutation, and unchanged 659-subject Workflow tests | PASS |
| R2/pointer failures retain the old public version | D1 pending, R2 PUT/GET, schema/generation/hash/key, definite KV, and ambiguous KV tests | PASS |
| Bootstrap is replayable and missing resource/migration failures stop before upload | provision/resolve tests plus deploy dependency audit | PASS |
| Existing public APIs remain on legacy KV | `apps/read-worker/src/index.ts` constructs `KVStorage` for collections/calendar/health and reads cache keys from KV; deploy-config test proves D1/data-R2 are not referenced after `ReadEnv`; read-worker 33/33 tests pass | PASS |

## Code-quality review

- Final review found and corrected two release-blocking media-protocol defects:
  the V3 compatibility routing defect and the shared V3/V4 generation fence.
  Both corrections and fresh evidence are recorded below.
- D1 collection mutations are CAS-protected and replay reconciliation accepts
  only exact persisted outcomes.
- Publication uses D1 pending/verified/source/claim state, immutable R2 bytes,
  full readback validation, a fenced single KV pointer write, and post-pointer
  D1 promotion.
- D1-only media V4 fails closed without D1 and never falls back to legacy
  subject KV; live V3 and V2/legacy compatibility remain intentionally
  separate.
- Read Worker shadow bindings are present for deployment compatibility but are
  unused by current public handlers.

The earlier verifier verdict was superseded by the final compatibility reviews.
The corrections below must receive fresh independent approval before OpenSpec
6.1 or release integration.

## Historical correction ledger: V3 compatibility

Review base: `6be4fd8eb94d065d952ef29896d6575de863f4fc`.

The live Workflow already emitted `MediaRefreshJobV3`, while the current Read
Worker and live refresh planner still consume legacy subject detail, metadata,
image, and refresh KV. Task 8 had routed every V3 job to D1-only state, so a
successful live refresh was invisible to public hydration and the next planner
pass.

The correction preserves V3 as the live legacy-compatible job and introduces
the explicit D1-only `MediaRefreshJobV4`. Only the D1 incremental producer emits
V4. Canonical validation, D1 reservation fingerprints, live/D1 Queue routing,
Durable Object generation handling, and direct Media routing now keep the two
contracts unambiguous. V4 without D1 remains retryable and performs zero legacy
per-subject KV writes.

RED composition evidence used the real live Workflow producer, Media Queue
consumer, Read Worker calendar hydration, and the next legacy planner pass.
Before source changes, Read returned the stale episode count `1` instead of the
refreshed `24`.

Historical focused GREEN evidence at that correction:

- 129/129 Workflow, planner, Media, D1 media, D1 orchestration, reservation,
  canonical-validation, and compatibility tests passed;
- storage, media-worker, and sync-worker typechecks passed;
- the live Workflow V3 integration now exposes episode count `24` through Read
  and produces no next refresh candidate;
- V4 Queue/direct/DO tests prove missing D1 is retryable with zero legacy KV;
- the D1 budget fingerprint test rejects a replay that changes only V4 to V3;
- the root script suite passes 23/23 and worker-common configuration suite
  passes 13/13.

Historical repository verification after the compatibility correction:

- `pnpm test`: **524/524 passed**;
- `pnpm typecheck`: **all nine workspace projects passed**;
- `pnpm build:check`: **all four Worker builds and dry-runs passed**;
- production-shaped frontend/read/media/sync Wrangler configs passed an
  executable no-placeholder and exact binding-matrix assertion using only
  canonical fake D1/KV identifiers;
- Wrangler 4.100.0 materialized dry-runs passed at frontend 69.36 KiB / gzip
  16.65 KiB, read 22.91 / 6.15, media 112.17 / 21.79, and sync 226.65 / 45.67;
- the root script suite passed 23/23 and worker-common configuration suite
  passed 13/13;
- strict OpenSpec validation and `git diff --check` passed.

These local gates do not supply the remote migration, deployment, metrics,
shadow-comparison, or public-smoke evidence required for OpenSpec 6.1/6.2.

## Historical correction ledger: independent replay-stable V4 fence

Review base: `6f5699f7103987890362caf8c6fb76e1a3d4c98f`.

The first V4 producer used hard-coded generation `0`, while the production
subject Durable Object stored V2, V3, and V4 progress under the same numeric
keys. Once a live V3 generation advanced that fence, every D1-only V4 job was
obsolete. A retry-clock generation would have avoided zero but would not be
stable across Workflow step replay.

The correction preserves the deployed unprefixed V2/V3 numeric keys. V4 now
uses `v4:`-prefixed fence keys and a generation tuple
`{ observed_at, run_id }`, derived only from the persisted complete-input
observation and stable Workflow instance ID. Ordering compares `observed_at`
first and `run_id` second. Canonical validation and D1 reservation
fingerprinting include the full tuple.

Strict TDD RED evidence used the real `SubjectRefreshCoordinator.fetch`
production path, canonical validator, and D1 incremental producer. Before the
source correction, 42 focused tests produced the expected four failures:

- V4 tuple requests were rejected with HTTP 400;
- generated V4 jobs still carried generation `0`;
- retry-clock changes could not demonstrate a stable authoritative tuple;
- canonical V4 validation rejected the tuple.

Fresh GREEN evidence proves the exact production sequence V3 N, V4 A, replay A,
newer V4 B, delayed A, V3 N+1. A executes once, replay A is duplicate, B
executes, delayed A is obsolete, and N+1 still executes. The final stored
legacy generation is N+1 while `v4:lastCompletedGeneration` is B. Additional
tests prove the producer ignores retry `now`, a changed tuple mismatches the
reservation fingerprint, and V2/V3 migration keys remain unchanged.

Those full, focused, typecheck, build, exact materialized-binding,
four-dry-run, strict OpenSpec, and diff results are superseded by the current
authoritative evidence below. No deploy, merge, task checkoff, or production
verification was performed.

## Superseded Final Review ledger

- Runtime `79cbb3462ea91680fcc3c3fb62ea96af401bfb68` with **519/519**
  full and **117/117** focused tests was a preliminary Final Review snapshot.
  It predates strict unknown-version rejection, independent V4 generation
  fences, D1 media public projection, and durable due-check schedule
  advancement; it is historical and MUST NOT be used as current release
  evidence.
- Runtime `97469a62ed78769e595ef3f3ca9c3c3ed47cf0e7` with **524/524**
  full and **129/129** focused tests superseded that preliminary snapshot after
  the V3/V4 protocol corrections. It is also historical because the later
  media-projection and schedule-watermark review found two additional blockers.

## Current authoritative correction: D1 media projection and due schedule watermark

Runtime `ff999c0d5d21bbf450d1315c8b440182b79948c7` is the current
authoritative local release candidate.

Strict TDD RED evidence produced three expected failures:

- a completed D1 media row left the next daily snapshot hash unchanged and
  collections/calendar still used null images and upstream detail;
- invalid-detail/tombstone rows did not project their authoritative NSFW and
  valid retained image reference;
- a successful due check with identical semantic media returned zero D1 writes,
  leaving the expired schedule watermark unchanged.

The correction reads `subject_media` before creating the collection replay
checkpoint and freezes that exact projection into the checkpoint. Collection
and calendar projections accept only matching-subject detail JSON and
`images/{lowercase-sha256}/original` refs, fall back to complete upstream data
for invalid detail, and retain valid image refs under conservative NSFW
tombstones. A running replay continues to use the frozen projection even when
media changes after the checkpoint commit.

For successful due V4 semantic no-ops, Media now writes only `checked_at` and
the existing deterministic 6–8 day `next_refresh_at`. The immutable detail,
media hashes, source/R2 pairs, and image R2 bytes stay unchanged. The next-day
hot planner test selects zero jobs before the new boundary, while an identical
not-due check remains a D1/R2 zero-write no-op.

Current GREEN evidence:

- focused projection/schedule pair: **49/49 passed**;
- sync-worker: **190/190 passed**;
- media-worker: **55/55 passed**;
- focused media lifecycle/compatibility/fence gate: **134/134 passed**;
- full repository: **529/529 passed**;
- all nine workspace typechecks passed;
- all four checked-in Worker build checks and dry-runs passed;
- four exact materialized configs contained no placeholders, matched the
  required/forbidden binding matrix, and passed Wrangler 4.100.0 dry-run:
  frontend 69.36 KiB / gzip 16.65 KiB, read 22.91 / 6.15, media 112.28 /
  21.82, and sync 229.63 / 46.46;
- strict OpenSpec validation and `git diff --check` passed.

This evidence still performs no deployment, merge, production migration,
production Workflow, public smoke test, or OpenSpec 6.1/6.2 checkoff.

## Explicitly pending production evidence

- remote D1 migration: **pending**;
- release-candidate integration into `dev`: **pending user decision**;
- deployment workflow URL/run ID/deployed SHA: **pending**;
- live resolved resource matrix and metrics: **pending**;
- shadow snapshot readback and legacy comparison: **pending**;
- public production smoke tests: **pending**;
- OpenSpec 6.1 and 6.2: **unchecked**;
- Comet build guard and transition to `verify`: **not run**.

The next production step must preserve the public Read Worker on legacy KV. The
separate `migrate-public-reads-from-kv` change continues to own import, cutover,
fallback, and legacy cleanup.
