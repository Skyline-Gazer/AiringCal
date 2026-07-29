---
comet_change: adopt-d1-r2-incremental-sync
role: task-12-verification-ready
status: local-evidence-ready-pending-independent-review-and-production
verified_scope: full-local-gates-materialized-dry-runs-v3-v4-compatibility
verified_source_sha: 79cbb3462ea91680fcc3c3fb62ea96af401bfb68
---

# D1/R2 incremental sync verification-ready evidence

This report records current local evidence for runtime source SHA
`79cbb3462ea91680fcc3c3fb62ea96af401bfb68`. The documentation-truth correction
after that commit contains no runtime or configuration change, so this remains
the exact implementation reviewed by the gates below.

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
| `pnpm test` | PASS | 519/519 tests, 0 failed |
| `pnpm typecheck` | PASS | all 9 workspace projects completed |
| `pnpm build:check` | PASS | frontend/read/media/sync types current and dry-runs completed |
| `./node_modules/.bin/openspec validate adopt-d1-r2-incremental-sync --strict` | PASS | `Change 'adopt-d1-r2-incremental-sync' is valid` |
| `git diff --check` | PASS | no output |
| focused V3/V4 compatibility command listed below | PASS | 117/117 tests, 0 failed |

Wrangler's default macOS debug-log directory is outside this worktree sandbox.
The first `pnpm build:check` still exited 0 and completed all bundles, but
emitted `EPERM` diagnostics while attempting to write that debug log. Source
inspection of installed Wrangler 4.100.0 confirmed `WRANGLER_LOG_PATH`; the
same gate was rerun as
`WRANGLER_LOG_PATH=/tmp/bangumitv-v3-compat-build-logs pnpm build:check` and
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
| `@airing-cal/sync-worker` | 185 |
| `@airing-cal/media-worker` | 50 |
| root script tests | 23 |
| **Total** | **519** |

Package counts that were not visible in the terminal's truncated full-run
stream were confirmed with Node's native test runner plus the installed `tsx`
loader; those count checks also passed.

### Focused acceptance command

```bash
node --import tsx --test \
  packages/storage/src/media-job.test.ts \
  apps/media-worker/src/media-worker.test.ts \
  apps/media-worker/src/subject-refresh-coordinator.test.ts \
  apps/media-worker/src/d1-media-state.test.ts \
  apps/sync-worker/src/d1-sync.test.ts \
  apps/sync-worker/src/snapshot-coordinator.test.ts \
  apps/sync-worker/src/workflow.test.ts
```

Result: **117/117 passed, 0 failed**.

## Materialized Wrangler verification

Temporary configs used only canonical fake identifiers:

- D1 database ID:
  `11111111-1111-4111-8111-111111111111`;
- KV namespace ID:
  `11111111111111111111111111111111`;
- frontend build SHA:
  `79cbb3462ea91680fcc3c3fb62ea96af401bfb68`.

Read, Media, and Sync were materialized with resource IDs only, matching their
deploy jobs. Frontend was materialized with build metadata, matching its
separate deploy job. An executable assertion rejected unresolved
`<PLACEHOLDER>`-style values and checked both required and forbidden bindings.

| Config | Asserted materialized matrix | Dry-run |
|---|---|---|
| Read | D1 + legacy KV + image R2 + data R2; no Queue/Workflow/DO | PASS, 22.91 KiB / gzip 6.15 KiB |
| Media | D1 + legacy KV compatibility + image R2 + Queue consumer + `SubjectRefreshCoordinator`; no data R2/Workflow | PASS, 110.10 KiB / gzip 21.44 KiB |
| Sync | `SyncWorkflow` + D1 + data R2 + legacy KV compatibility + media Queue producer + `SnapshotCoordinator`; no image R2/Queue consumer | PASS, 226.54 KiB / gzip 45.65 KiB |
| Frontend | Read and Sync service bindings plus build metadata only | PASS, 69.36 KiB / gzip 16.65 KiB |

The four exact materialized configs all passed:

```bash
WRANGLER_LOG_PATH=/tmp/bangumitv-doc-truth-wrangler.Lh40jP/wrangler-<app>.log \
  pnpm exec wrangler deploy --dry-run \
  --outdir /tmp/bangumitv-doc-truth-wrangler.Lh40jP/dist-<app> \
  --config /tmp/bangumitv-doc-truth-wrangler.Lh40jP/wrangler-<app>.toml
```

One discarded setup attempt incorrectly supplied frontend-only
`BANGUMI_GIT_*` variables to Sync and therefore appended a duplicate `[vars]`
table. `.github/workflows/deploy.yml` proves those variables are scoped only to
the frontend job. The production-mirroring rematerialization above is the
accepted evidence; no repository file was changed to hide the setup error.

## OpenSpec requirement audit

Every added requirement was checked against implementation and an executable
test. The result is **16/16 locally approved**.

| OpenSpec requirement | Authoritative source | Fresh executable evidence | Result |
|---|---|---|---|
| State resources are replay-safe to bootstrap | `scripts/cloudflare-resource-contract.mjs`; `scripts/provision-cloudflare-resources.mjs` | provision tests create once, reuse D1 ID, re-list races, and replay later pages/cursors | PASS |
| D1 migration precedes Worker upload | `.github/workflows/deploy.yml` | deploy-config test reconstructs `resolve → migration → read/media → sync → frontend` dependencies | PASS |
| Missing resources fail before upload | `scripts/resolve-cloudflare-resources.mjs` | resolver tests cover missing D1, KV, data R2, image R2, and Queue | PASS |
| D1 stores mutable authoritative state | `migrations/0001_d1_authoritative_state.sql`; `packages/storage/src/d1-state-store.ts` | migration/schema and typed state-store tests in the 519-test gate | PASS |
| Collection diff ignores runtime fields | `packages/storage/src/canonical-json.ts`; `packages/domain/src/collection-diff.ts` | canonical hash excludes observation fields; later identical observation plans zero writes | PASS |
| Deletion requires two successful complete reads | `packages/domain/src/collection-diff.ts` | first/second missing, same-run replay, incomplete input, and vanished staged page tests | PASS |
| QoS budget reservation is atomic | `packages/storage/src/d1-budget.ts` | final-slot concurrency, stable reservation replay, and hard-limit tests | PASS |
| Workflow incrementally commits D1 | `apps/sync-worker/src/d1-sync.ts` | unchanged writes zero rows, one change writes one, replay avoids a second mutation, lifecycle counters persist | PASS |
| Workflow publishes a verifiable R2 candidate | `apps/sync-worker/src/workflow-core.ts`; `apps/sync-worker/src/r2-publication.ts` | D1-before-publication integration plus changed/no-op/failure publication tests | PASS |
| Subject media authority is D1 and new flow avoids subject KV | `apps/media-worker/src/d1-media-state.ts`; `apps/media-worker/src/index.ts` | semantic no-op is zero D1/R2 writes; D1-only V4 Queue/direct/DO paths perform no legacy per-subject puts | PASS |
| Cold media rotates across seven days | `apps/sync-worker/src/refresh-planner.ts` | all seven residues selected exactly once and D1 orchestration exercises seven UTC shards | PASS |
| Public snapshot is one immutable object | `packages/domain/src/public-snapshot.ts`; `apps/sync-worker/src/r2-publication.ts` | exact content-addressed key plus changed publication ordering test | PASS |
| Unchanged public content performs zero publication writes | `apps/sync-worker/src/r2-publication.ts` | identical verified content allocates no generation and performs zero R2/KV writes | PASS |
| Pointer switches last | `apps/sync-worker/src/r2-publication.ts` | event-order test and D1/R2/readback/KV injected failures preserve the prior pointer | PASS |
| D1/R2 publication is automatically verified | `.github/workflows/ci.yml`; package test scripts | full 519/519 gate plus focused 117/117 V3/V4 compatibility gate | PASS |
| Deploy config resolves all state resources | `scripts/materialize-wrangler-config.mjs`; Worker TOMLs; deploy workflow | no-placeholder matrix assertion plus four materialized Wrangler dry-runs | PASS |

## Design §10 acceptance audit

The result is **8/8 locally approved**.

| Criterion | Evidence | Result |
|---|---|---|
| Identical complete input: collection 0 writes, data R2 0 PUT, generation unchanged, `public:current` 0 PUT | `d1-sync.test.ts`: unchanged input and response-loss replay; `d1-state-store.test.ts`: unchanged plan/replayed transition zero writes; `r2-publication.test.ts`: unchanged before allocation/R2/KV | PASS |
| Rate, tags, comment, collection status, episode and volume progress change without depending on `updated_at` | collection-diff business-field matrix changes each field independently while the fixture timestamp remains constant and plans exactly one update | PASS |
| First missing is retained; only a later complete miss deletes; partial/failed pages never advance deletion | domain, D1 orchestration, and staged-page disappearance tests | PASS |
| Daily media grant stays `<= 100` under concurrency and replay | D1 final-slot concurrency and replay tests; coordinator concurrent/replayed hard-limit tests; Workflow hard-limited counter test | PASS |
| New media flow writes no per-subject legacy KV | V4 no-D1 fail-closed, D1-only Queue/direct/DO, and unchanged 659-subject Workflow tests | PASS |
| R2/pointer failures retain the old public version | D1 pending, R2 PUT/GET, schema/generation/hash/key, definite KV, and ambiguous KV tests | PASS |
| Bootstrap is replayable and missing resource/migration failures stop before upload | provision/resolve tests plus deploy dependency audit | PASS |
| Existing public APIs remain on legacy KV | `apps/read-worker/src/index.ts` constructs `KVStorage` for collections/calendar/health and reads cache keys from KV; deploy-config test proves D1/data-R2 are not referenced after `ReadEnv`; read-worker 33/33 tests pass | PASS |

## Code-quality review

- Final review found and corrected one release-blocking V3 compatibility defect;
  the correction and fresh evidence are recorded below.
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

The earlier verifier verdict was superseded by the final compatibility review.
The correction below must receive fresh independent approval before OpenSpec
6.1 or release integration.

## Release-blocking final review correction: V3 compatibility

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

Fresh focused GREEN evidence:

- 117/117 Workflow, planner, Media, D1 media, D1 orchestration, reservation,
  canonical-validation, and compatibility tests passed;
- storage, media-worker, and sync-worker typechecks passed;
- the live Workflow V3 integration now exposes episode count `24` through Read
  and produces no next refresh candidate;
- V4 Queue/direct/DO tests prove missing D1 is retryable with zero legacy KV;
- the D1 budget fingerprint test rejects a replay that changes only V4 to V3.
- the focused documentation/configuration suite passes 28/28.

Fresh repository verification after the compatibility correction:

- `pnpm test`: **519/519 passed**;
- `pnpm typecheck`: **all nine workspace projects passed**;
- `pnpm build:check`: **all four Worker builds and dry-runs passed**;
- production-shaped frontend/read/media/sync Wrangler configs passed an
  executable no-placeholder and exact binding-matrix assertion using only
  canonical fake D1/KV identifiers;
- Wrangler 4.100.0 materialized dry-runs passed at frontend 69.36 KiB / gzip
  16.65 KiB, read 22.91 / 6.15, media 110.10 / 21.44, and sync 226.54 / 45.65;
- the focused documentation/configuration suite passed 28/28;
- strict OpenSpec validation and `git diff --check` passed.

These local gates do not supply the remote migration, deployment, metrics,
shadow-comparison, or public-smoke evidence required for OpenSpec 6.1/6.2.

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
