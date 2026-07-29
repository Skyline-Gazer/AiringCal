# Subagent Progress

- Change: `adopt-d1-r2-incremental-sync`
- Plan: `docs/superpowers/plans/2026-07-22-free-plan-d1-r2-incremental-sync.md`
- Review mode: `thorough`
- TDD mode: `tdd`

## Current Task

- Plan task: `Task 1: 两阶段发布的资源 bootstrap/resolve 兼容层`
- OpenSpec mappings:
  - `1.1 Verify Wrangler D1/R2 CLI and config contracts from help, types and official docs`
  - `1.2 Extend manual bootstrap and resource resolve to create/reuse airing-cal-state and airing-cal-data without changing runtime bindings`
  - `1.3 Add D1 ID materialization, tests and documentation, commit/push, then run bootstrap before binding-dependent deployment`
- Stage: `checkoff`
- Review/fix round: `2/2`
- Implementation base: `cdaf4fb`
- RED evidence: missing shared contract module; provision missing D1 ID; resolve omitted D1/R2/Queue validation; materializer accepted unresolved D1 placeholder.
- GREEN evidence: 14/14 compatibility tests; full `pnpm test`; full `pnpm typecheck`; OpenSpec strict; diff check.
- Implementation commit: `ba34ee1e9f2ff5ec506a03c0e4680f7e20c1992e`
- Changed files: resource contract/provision/resolve/materialize scripts and tests, bootstrap workflow, README, monorepo architecture document.
- Compatibility audit: no D1/data R2 Worker binding, migration, or runtime access was introduced.
- Fix commit: `6849cd37c95b5afdd2ed976a99208c0bcd72be59`
- Fix RED evidence: later-page/cursor provision replay, complete already-exists re-list and resolver pagination tests failed 3/11 before implementation.
- Fix GREEN evidence: 17/17 compatibility tests; full test/typecheck/build; OpenSpec strict; diff check.
- Review result: spec compliance APPROVED; code quality APPROVED.
- Resolved findings: D1/KV/Queue page iteration, R2 cursor iteration, already-exists complete re-list, D1 Edit permission documentation, compatibility-stage wording.
- Checkoff: OpenSpec 1.1–1.3 and plan Task 1 complete; the production bootstrap barrier passed before Task 2 began.
- Resolver gate TDD RED: worker-common workflow test failed 11/12 because bootstrap did not run the read-only resolver after provision.
- Resolver gate TDD GREEN: bootstrap now runs provision → read-only resolver → safe report using resolver-confirmed D1/KV outputs; focused worker-common 12/12, resource scripts 17/17, full test/typecheck/build, OpenSpec strict and diff check passed.
- Resolver gate scope audit: no runtime D1/data R2 binding or Task 2 code was added.
- Resolver gate commit: `791acb95cc0777df8f1dd8fdbe6b662182120bcb`; independent spec and quality review both APPROVED with no findings.
- Production bootstrap evidence: GitHub Actions run `30208798689` (`https://github.com/markd3ng/AiringCal/actions/runs/30208798689`) succeeded at `791acb95cc0777df8f1dd8fdbe6b662182120bcb`.
- Production resources: D1 `airing-cal-state` (`7b56ac09-369a-4912-a2a3-8a09ede05cf1`), data R2 `airing-cal-data`, image R2 `airing-cal-images`, KV namespace `e0c01d4da9c64b59badb2005dd644562`, Queue `airing-cal-media`.
- Production resolver result: provision replay succeeded, then the read-only resolver verified all five resource classes and returned the same canonical D1/KV IDs; workflow logs masked credentials and exposed no request headers.

## Task 2 Implementation

- Plan task: `Task 2: D1 migration 与 typed state contracts`
- OpenSpec mapping: `2.1 Add migrations for collection_items, subject_media, sync_runs, sync_budget and app_state without secondary indexes`
- Stage: `checkoff`
- Implementation base: `a268d4f`
- CLI/config evidence: installed Wrangler `d1 migrations apply/list` help confirms database positional plus `--local`, `--persist-to`, and `--config`; `d1 execute` help confirms `--command` and `--json`; installed Wrangler types confirm `d1_databases` and `migrations_dir`.
- RED evidence: focused migration suite failed 2/2 because `migrations/0001_d1_authoritative_state.sql` and `packages/storage/wrangler.d1-test.toml` did not exist.
- GREEN evidence: focused migration suite 2/2; isolated local migration applies once and replay reports no pending migrations; `sqlite_schema` and `pragma_table_info` match the five authoritative tables, reservation helper, and Wrangler bookkeeping exactly.
- Contract scope: exports typed D1 rows, database/statement structural interfaces, and versioned public snapshot/pointer shapes; error persistence exposes classified `error_code` only.
- Schema scope: no `CREATE INDEX`, foreign key, runtime Worker binding, production migration, canonical JSON/hash helper, or Task 3 implementation.
- Verification: storage typecheck and 12/12 tests; full repository typecheck/test/build check; OpenSpec strict; diff check all pass.
- Quality review round: `1/2 REJECTED → fixed; 2/2 APPROVED`.
- Review-fix RED evidence: exact PRAGMA expectation failed because SQLite reported `app_state.key` as `notnull=0`; concrete public payload type test failed compilation because collections/calendar/summary were unknown.
- Review-fix implementation: all TEXT primary keys are explicitly `NOT NULL`; migration tests lock every application column's type, nullability, default and PK ordinal, reject NULL primary-key inserts, assert required CHECK constraints and clean temporary D1/log state; public snapshot contracts now expose concrete collection, calendar, summary, image-reference and NSFW projections.
- Review-fix GREEN evidence: focused migration 2/2; storage typecheck and 13/13 tests; full repository typecheck/test/build check; OpenSpec strict and diff check pass.
- Final review result: fresh spec compliance APPROVED and code quality APPROVED with no Critical, Important, or Minor findings.
- Task 2 checkoff: plan Steps 1–5 and OpenSpec 2.1 complete; implementation commits `8a9fc2c1a650afd65e4fb79baee9e9f5bf5514b8` and `40c92e1fa2b981d5e29e6cacfc93739e0eaf1aaa` are pushed.

## Task 3 Implementation

- Plan task: `Task 3: 规范 JSON、业务 hash 与公开契约`
- OpenSpec mappings:
  - `2.2 Implement typed D1 adapters, stable canonical JSON/hash helpers and row mapping tests`
  - `4.1 Define and validate PublicSnapshotV1/PublicSnapshotPointerV1 and deterministic content hashing`
- Stage: `checkoff`
- Implementation base: `f671fb3`
- RED evidence: focused canonical/snapshot suite failed because `canonical-json.ts` and `public-snapshot.ts` did not exist.
- GREEN evidence: focused 21/21; storage 23/23; domain 40/40; package and full-repository typecheck/test/build checks pass.
- Canonical contract: recursive plain-object key ordering, array order preservation, explicit `undefined` to `null`, UTF-8 SHA-256, lowercase 64-character hex and non-finite number rejection.
- Collection hash scope: detects rate, tags, comment, collection type, episode/volume progress, public `updated_at`, and explicit public subject projection changes while excluding runtime observation/publication fields and opaque subject keys.
- Snapshot contract: groups all five collection types, derives summary, retains calendar/image/NSFW projections, excludes envelope fields from content hash, deeply validates every nested field and summary invariant, verifies its own hash, rejects unknown schema/collection types and produces the exact immutable object key.
- Scope audit: no collection diff, R2 publication, Worker runtime binding or legacy read-path change was introduced.
- Checkoff: OpenSpec 4.1 is complete. OpenSpec 2.2 remains open because Task 5 still must provide the typed D1 adapter and remaining row-mapping evidence.
- Review/fix round: `1/3 REJECTED → fixed; 2/3 REJECTED → fixed; 3/3 APPROVED`.
- Review-fix RED evidence: 9/17 focused assertions failed for public timestamp hashing, subject allowlisting, publication envelope, unknown collection types and deep/self-consistent snapshot parsing; a second RED cycle failed 2/9 for invalid envelope values and bucket/identity invariants.
- Review-fix implementation: `upstream_updated_at` now participates as public `updated_at`; subject object/JSON use an explicit OpenAPI-backed public allowlist; snapshots carry validated `published_at`; the async parser validates exact nested contracts, five buckets, counters, image/NSFW fields and lowercase SHA-256 before recomputing the stable payload hash.
- First review-fix GREEN evidence: focused 19/19; storage 23/23; domain 38/38; full repository test/typecheck/build check; frozen lockfile; OpenSpec strict and diff check all pass.
- Second review-fix RED evidence: 2/21 focused assertions failed because `subject_type` did not affect the business hash and the builder accepted typed inputs that the parser rejected.
- Second review-fix implementation: `CollectionContentInput` now explicitly requires and hashes top-level `subject_type`; builder and parser share the same complete structure/semantic validator, so invalid rates, image hashes, calendar identities and other contract violations cannot be emitted.
- Second review-fix GREEN evidence: focused 21/21; storage 23/23; domain 40/40; full repository test/typecheck/build check; frozen lockfile; OpenSpec strict and diff check all pass.
- Final review result: fresh spec compliance APPROVED and code quality APPROVED with no Critical or Important findings.
- Task 4 guard: normalization must preserve top-level `subject_type` in the normalized public projection while passing it explicitly to `collectionContentHash`, because the current D1 row has no separate `subject_type` column.
- Task 3 checkoff: plan Steps 1–5 and OpenSpec 4.1 complete; OpenSpec 2.2 remains open for Task 5 typed adapters/row mapping. Commits `148f3e660046c9c2c1e9375e00e3172260df7eda`, `4da7cdaba95ccc7e2f8e3d93d2c902fcfb16246b`, and `b316fdb03a39caca50861e8af6aeb37c516bfc8c` are pushed.

## Task 4 Implementation

- Plan task: `Task 4: 收藏内存 diff 与两次缺失确认`
- OpenSpec mappings: `3.1` complete fetch/runtime-field-free diff; `3.2` two-successful-missing and pagination-failure protection.
- Stage: `checkoff`
- Implementation base: `7da3a61`
- API contract evidence: checked-in `UserSubjectCollection` requires `subject_id`, `subject_type`, `rate`, `type`, `tags`, `ep_status`, `vol_status`, `updated_at` and `private`; collection `type` is 1–5; the contract warns that `updated_at` does not reliably change for rating, comment or episode progress.
- RED evidence: focused domain and sync boundary suites failed because `collection-diff.ts` and `full-fetch-boundary.ts` were absent. The initial sandbox run was discarded because `tsx` could not create its IPC socket; the permitted rerun produced the expected missing-module failures.
- GREEN evidence: domain 57/57 and sync-worker 79/79; both package typechecks; full repository test/typecheck/build check; frozen lockfile; OpenSpec strict and diff check pass.
- Diff contract: explicit inserts, updates, unchanged count, first missing, confirmed deletion and restoration; identical business input performs no row transition despite a new observation time; incomplete fetches never advance missing/deletion state.
- Normalization contract: top-level `subject_type` is passed explicitly into the stable content hash and retained as the public projection `type`; watched is cold and all other collection states are hot.
- Full-fetch boundary: Workflow only receives `complete: true` after every staged collection page is present, per-user counts equal the first-page declared totals, and calendar staging is present.
- Scope audit: no D1 adapter/persistence, budget, R2 publication, runtime binding or legacy public-read change was introduced.
- Review/fix round: `1/2 REJECTED → fixed; fresh reviews pending`.
- Review findings: the initial boundary flattened away per-page totals/offsets and could not detect total drift, duplicates or gaps; same-observation replay could confirm deletion; `private` and opaque subject fields were not handled by one stable persisted projection; composite-key/tag-order coverage was incomplete.
- Fix RED evidence: storage failed private hash coverage 1/11; domain failed same-observation replay, private toggle and stable subject projection 3/22; boundary failed seven page/calendar integrity cases before implementation.
- Privacy decision: OpenAPI requires collection `private` as a boolean, while the existing `PublicCollectionItemV1`, legacy merged entry and public snapshot contracts intentionally contain no such field. The authoritative persisted subject envelope and content hash therefore retain `private`, but the public item filters it out.
- Tag decision: OpenAPI and the public contract model tags as an array, and canonical JSON preserves array order. Normalization does not sort tags; it preserves their public order and reordering changes the business hash.
- Fix implementation: shared `persistedCollectionSubject` stores only `subject_type`, `private` and the exact allowlisted public subject projection; opaque rating, extra image sizes and runtime keys change neither the hash nor persisted JSON. Planner identity now uses nested user/subject maps, and deletion requires `observedAt > missing_since`.
- Boundary fix: Workflow retains each page's requested offset, declared total and staged data. The boundary requires safe totals/offsets, consistent totals, exact page count/length, contiguous offsets, unique positive subject IDs per user, unique count equal to total, and a runtime calendar array.
- Workflow regression: a vanished staged second page produces `Incomplete collection fetch`, zero coordinator commits and no publication step.
- Fix GREEN evidence: storage 25/25, domain 62/62, sync-worker 84/84; full repository test/typecheck/build check; frozen lockfile; OpenSpec strict and diff check all pass.
- Second fresh review: `REJECTED → fixed; next fresh reviews pending`.
- Second-review findings: calendar validation was only top-level; replay/clock regression still emitted a first-missing mutation; Workflow had not exposed one stable observation value; complete input flattened user identity; staged digests were not rechecked; mutation arrays followed upstream page order.
- Second-fix RED evidence: planner failed three replay/sorting assertions; full-fetch boundary failed eight deep-calendar/identity/observation assertions; a tampered staged page incorrectly completed the Workflow.
- Second-fix implementation: deep calendar validation now checks day, weekday, items and the OpenAPI/current-client item core; `observedAt <= missing_since` is a no-op; all mutation arrays sort by `(user_id, subject_id)`; complete collections retain `{ user_id, collection }`; staged page JSON must reproduce the fetch-step digest.
- Stable observation contract: `assembleFullFetch` requires and returns an explicit observation. Workflow passes the persisted `SyncRun.started_at` and writes it into the prepared staging record; a forced prepare-step retry proves the value remains identical. Task 7 integration MUST pass this `completeInput.observedAt` unchanged into `planCollectionDiff` rather than calling `Date.now`.
- Multi-user contract: a Workflow test fetches the same subject for `alice,bob`, retries preparation once, and succeeds without collapsing the identities at the complete-input boundary.
- Second-fix GREEN evidence: domain focused 24/24; boundary 15/15; Workflow focused 16/16; full repository storage 25/domain 64/sync-worker 93 plus all other tests; full typecheck/build check pass.
- Third fresh review: `REJECTED → fixed; next fresh reviews pending`.
- Third-review findings: Workflow rechecked staged collection digests but not the staged calendar digest; calendar validation treated optional OpenAPI fields as required; `localeCompare` made mutation ordering environment-dependent; duplicate user groups were accepted.
- OpenAPI/default decision: the checked-in calendar schema does not declare `eps`, image sizes, rating fields or dates as required. The boundary validates the day/weekday/items structure and the subject identity/core fields needed downstream, accepts absent optional fields, and supplies stable zero/empty defaults where the public projection requires them.
- Third-fix RED evidence: domain ordering failed 1 assertion; full-fetch boundary failed duplicate-user and minimal-calendar assertions 2/17; a structurally valid tampered staged calendar incorrectly completed the Workflow 1/17.
- Third-fix implementation: mutation ordering uses an explicit JavaScript UTF-16 code-unit comparator; complete fetch rejects duplicate `user_id` groups; minimal OpenAPI-compatible calendar entries normalize safely while malformed required downstream fields still fail; Workflow recomputes the staged calendar digest before assembly.
- Third-fix GREEN evidence: domain focused 25/25; boundary focused 17/17; Workflow focused 17/17; full repository storage 25/domain 65/sync-worker 96 plus all other tests; full typecheck/build check, frozen lockfile, OpenSpec strict and diff check pass.
- Task 5 integration guard: consume complete collection entries as `{ user_id, collection }` through D1 normalization and diff planning; do not flatten user identity before authoritative row mapping.
- Checkoff guard: OpenSpec 3.1 and 3.2 remain pending until the next fresh independent spec-compliance and code-quality reviews both approve.
- Final-final spec review: `REJECTED → fixed; fresh dual approval still pending`.
- Final-final finding: checked-in `Legacy_SubjectSmall` declares no required property list, so the calendar boundary still incorrectly rejected otherwise valid subjects that omitted `name`, `name_cn` or `summary`.
- Final-final RED evidence: the genuinely minimal calendar subject `{ id: 1, type: 2 }` failed the focused boundary suite 1/17 with `Incomplete calendar fetch`.
- Final-final implementation: `id` and `type` remain required as local subject identity/discriminator inputs; absent optional `name`, `name_cn` and `summary` normalize to stable empty strings, while present non-string values remain malformed.
- Final-final GREEN evidence: boundary focused 17/17; sync-worker 96/96 and package typecheck; full repository test/typecheck/build check; frozen lockfile; OpenSpec strict and diff check all pass.
- Checkoff guard remains active: OpenSpec 3.1 and 3.2 are still pending.
- Ultimate quality review: `REJECTED → fixed; final fresh dual approval still pending`.
- Ultimate findings: OpenAPI-optional collection `comment` could reach the D1 row as `undefined`; calendar normalization spread opaque legacy fields, retained rating objects without scores, and read rank from the wrong nested location; Workflow publication reread the original staged calendar instead of the normalized complete input.
- Ultimate RED evidence: domain focused failed 1/26 because an omitted comment produced an undefined D1 value; boundary/Workflow focused failed 3/36 for opaque field leakage/root-rank loss, scoreless rating retention, and an unstable checked-in OpenAPI-shaped public calendar.
- Ultimate implementation: collection normalization derives one `comment = entry.comment ?? ''` for both D1 and content hashing; calendar subjects are rebuilt from an explicit downstream allowlist; valid root `rank` takes precedence with a documented-compatible nested fallback; scoreless ratings are omitted; Workflow stages and publishes the normalized calendar rather than the raw upstream object.
- Ultimate OpenAPI integration evidence: the Workflow fixture uses legacy `air_date`, root `rank`, rating `count`, URL, collection counters and partial images, then asserts the exact stable public calendar output with no opaque fields.
- Ultimate GREEN evidence: focused domain/calendar 32/32 and boundary/Workflow 36/36; package domain 66/66 and sync-worker 98/98; package and full repository typecheck; full repository test/build check; frozen lockfile; OpenSpec strict and diff check all pass.
- Final fresh review result: spec compliance APPROVED and code quality APPROVED with no Critical, Important, or Minor findings.
- Task 4 checkoff: plan Steps 1–6 and OpenSpec 3.1–3.2 complete. Implementation/fix commits `319af48d2c37ac4777c63e2f7fda35a0e4f9c895`, `2ba7b2ca0aba09237d0b0fdf540f245f9b15d194`, `a17935f2de3091df5393cac04d079e3c662f69ff`, `ea4440aa8075e5368c1a7ab088ce33350634fbcd`, `aebb84c9f2c1194512c641a95a20429d92ead7f7`, and `8a59dec9aa17dd0d813302c3852efc4b29f44e3e` are pushed.

## Task 5 Implementation

- Plan task: `Task 5: Typed D1 adapter 与零写收藏提交`
- OpenSpec mapping: remaining adapter and row-mapping evidence for `2.2`.
- Stage: `checkoff`
- Implementation base: `297f99d`
- RED evidence: focused adapter suite failed because `d1-state-store.ts` did not exist; no production adapter code existed before the failing test.
- GREEN evidence: focused adapter 10/10; storage 35/35; storage and full-repository typecheck; full repository tests; build dry-runs; frozen lockfile diff; OpenSpec strict and diff check all pass.
- Collection persistence: explicit SELECT/INSERT/UPDATE column lists, positional binds, no `last_seen_at`, no batch call for unchanged plans, one statement for one changed row, exact insert/update/first-missing/confirmed-delete/restore mappings, deterministic `(user_id, subject_id)` ordering and batches bounded to 50 statements.
- Row boundary: collection JSON text and scalar fields are decoded and validated before returning typed rows; corrupt tags or subject JSON is rejected rather than passed downstream.
- App state: canonical `{ schema_version: 1, value }` envelopes only; unknown versions, missing values and corrupt JSON are rejected.
- Sync run lifecycle: start/update/complete/fail use prepared positional statements; persisted failures accept only uppercase classified error codes and reject raw body/comment/stack-like text before preparing SQL.
- Scope audit: no budget reservation, R2 publication, runtime binding, production migration, `last_seen_at`, Task 7 planner integration or legacy public-read change was introduced.
- Checkoff guard: OpenSpec `2.2` and plan Task 5 remain pending until fresh independent spec-compliance and code-quality reviews both approve.
- Quality review round: `1/2 REJECTED → fixed; fresh dual review pending`.
- Review findings: multi-batch writes were not replay-safe after a partial commit; deletion transitions and delayed full-row updates lacked compare-and-set protection; lifecycle terminal states could be overwritten after response loss; the D1 result abstraction omitted required metadata and counted attempted statements; explicit optional `undefined` reached binds; app-state generic casts lacked per-key runtime validation.
- Review-fix RED evidence: focused suite failed 8/17 assertions for conflict-safe inserts, collection CAS, actual `meta.changes`, app-state decoding, terminal lifecycle guards, undefined filtering and batch result validation. A separate self-review RED failed until business updates required a strictly newer observation.
- Review-fix implementation: inserts and run starts use conflict-safe no-op replay; 50-row chunk failure and post-commit response-loss tests replay without conflicts; first-missing/confirmed-delete match prior state; business updates require `changed_at < planned.changed_at`; restores require no newer row and an active missing/deleted state.
- D1 contract evidence: checked-in generated Worker types define `D1Result` with required `success: true`, `results` and `D1Meta`; the local structural type now requires `duration`, `size_after`, `rows_read`, `rows_written`, `last_row_id`, `changed_db` and `changes`, while retaining the generated optional serving/timing fields.
- Result/lifecycle safety: batch result count, success and metadata are validated; `rowsWritten` sums actual applied `meta.changes`, so stale CAS rows count zero. Start never overwrites; update/complete/fail only mutate nonterminal rows; repeated or opposite terminal transitions are no-ops, including complete-response-loss followed by catch-path fail.
- Validation safety: optional update fields with `undefined` are omitted from SQL/binds; `getAppState` accepts a per-key decoder and propagates invalid-value rejection after envelope validation.
- Final self-review RED: lifecycle and app-state writes exposed the same unvalidated D1 batch-result path outside collection diff.
- Final self-review implementation: all repository batch writes now share one cardinality/success/metadata validator.
- Review-fix GREEN evidence: focused adapter 19/19; storage 44/44; full repository typecheck/tests/build dry-runs; OpenSpec strict; lockfile and diff checks all pass.
- Checkoff guard remains active: OpenSpec `2.2` and plan Task 5 are still pending fresh independent spec-compliance and code-quality approvals.
- Final review round: `REJECTED → invariant/reconciliation fix implemented; next fresh dual review pending`.
- Final-review RED evidence: focused storage selected 16 tests with 11 expected failures covering migration/decoder/insert revision invariants, stale CAS reconciliation, post-transition delayed inserts, overlapping revision plans and explicit opposite-terminal outcomes.
- Revision invariant: migration enforces `state_version >= 1`, row decoding requires a positive safe integer and insert plans require exactly revision `1`.
- Initial-insert safety: conflict replacement is permitted only while the current row remains revision `1` with no missing/deleted state. Deterministic initial winners remain revision `1` and preserve earliest `first_seen_at`; any transitioned row rejects a delayed insert without clearing state.
- Zero-write reconciliation: collection batch results retain per-statement `meta.changes`. Every zero-change statement reads the exact current row; exact final-row equality is a safe replay, while any difference throws `Stale collection diff conflict: user_id:subject_id`. Real SQLite tests cover identical replay, overlapping revision losers and insert → missing → delete → delayed divergent insert.
- Task 7 integration guard: a stale collection diff conflict MUST trigger a fresh D1 list and complete replan before publication. The losing plan must never feed snapshot publication; Task 7 Step 2 and its acceptance tests repeat this requirement.
- Sync terminal result: complete/fail return explicit applied, same-terminal replay or preserved-opposite-terminal outcomes. Catch-path fail-after-ok no longer masks a committed success; missing runs still throw.
- Final-review GREEN evidence: storage 54/54 and domain 67/67; sync-worker 98/98 plus every other repository suite; full repository typecheck and Wrangler build dry-runs; migration apply/replay, frozen lockfile, OpenSpec strict and diff checks all pass.
- Checkoff guard remains active: OpenSpec `2.2` and plan Task 5 are still pending fresh independent spec-compliance and code-quality approvals.
- Ultimate review fix: insert-specific zero-write reconciliation accepts the SQL `MIN(first_seen_at)` preservation case only when the stored row remains initial, every other authoritative/business field is exact, and stored `first_seen_at <= planned.first_seen_at`; existing mutations retain exact full-row comparison.
- Barrel contract: `SyncTerminalTransitionResult` is exported from `@airing-cal/storage`, with a package-boundary consumer compiled by storage typecheck.
- Ultimate GREEN evidence: focused 7/7; storage 55/55; full repository tests/typecheck/Wrangler build dry-runs; frozen lockfile, OpenSpec strict and diff checks all pass.
- Checkoff guard remains active: OpenSpec `2.2` and plan Task 5 are pending the final fresh independent spec-compliance and code-quality approvals.
- Final structured-conflict fix: exported `StaleCollectionDiffError` carries stable `code = 'STALE_COLLECTION_DIFF'`, `userId` and `subjectId`; only divergent collection reconciliation throws it. Task 7 catches only this type for re-list/replan, while all unrelated D1/result/JSON errors fail normally.
- Sync-run identity: `startSyncRun` accepts only an exact persisted input replay. Reusing an instance ID with any different start payload throws `Sync run instance payload mismatch`; exact replay remains safe after a committed response loss.
- Final structured RED/GREEN: missing error exports failed runtime modules and barrel typecheck; focused GREEN is 10/10 plus storage typecheck. Full gates pending below.
- Final structured gates: storage 57/57; full repository tests/typecheck/Wrangler build dry-runs; frozen lockfile, OpenSpec strict and diff checks all pass.
- Checkoff guard remains active: OpenSpec `2.2` and plan Task 5 remain pending the final fresh independent review.
- Fresh review round: `2/3 REJECTED → revision fix implemented; next fresh dual review pending`.
- Revision finding: wall-clock `changed_at` was not a sufficient concurrency token for same-second divergent plans; first-writer-wins insert replay and unchecked generic app-state reads also left convergence/validation gaps, while zero-change sync transitions did not distinguish missing rows from terminal replay.
- Revision RED evidence: migration/domain focused failed 16/29 for the missing revision column and transition increments; adapter/node:sqlite focused failed row decode, same-second mutation, stale sequence, divergent empty inserts, typed state and sync existence/terminal assertions.
- Revision model: `collection_items.state_version INTEGER NOT NULL DEFAULT 1` is an optimistic-concurrency revision only. It is excluded from collection business hashing and public snapshots. Normalization initializes it to `1`; every planned business/missing/delete/restore mutation emits `previous + 1`.
- Revision persistence: every existing-row mutation sets the final revision with exact `WHERE state_version = final - 1`; stale plans return zero applied changes. A real in-memory SQLite sequence proves business update → stale missing, restore → new missing/delete → stale old restore, and same-second different-hash updates.
- Concurrent insert convergence: conflict inserts compare `(changed_at, content_hash COLLATE BINARY)`, preserve the earliest `first_seen_at`, and increment the existing revision only when the deterministic winner changes stored state. Old-first, new-first, equal-second divergent hash and replay sequences converge. Equal-second hash ordering is explicitly a convergence rule when true upstream order is unknowable; the next complete sync remains authoritative.
- Typed state/lifecycle: `getAppState` now requires a runtime decoder; explicit `getAppStateUnknown` names the raw boundary. Sync update/complete/fail query status after zero changes, reject missing rows, allow same-terminal replay, and reject opposite-terminal overwrite; response-loss completion followed by catch-path failure preserves `ok`.
- Cross-task compatibility: the not-yet-production-applied initial migration and exact schema tests were updated in place; Task 4 planner tests cover the revision sequence. OpenSpec `2.1`, `3.1`, and `3.2` remain complete because their implemented contracts were revised before production migration/runtime binding.
- Revision GREEN evidence: migration apply/replay and schema assertions 2/2; focused domain/adapter 50/50; storage 48/48, domain 67/67 and sync-worker 98/98; full repository tests, typecheck and build dry-runs; frozen lockfile, OpenSpec strict and diff checks all pass.
- Absolute final review result: spec compliance APPROVED and code quality APPROVED with no Critical, Important, or Minor findings.
- Task 5 checkoff: plan Steps 1–4 and OpenSpec 2.2 complete. The typed adapter, state revision model, replay reconciliation and structured stale-conflict contract are approved and pushed through `2ddf277111edea5c4c17b4f4a6736fdb8f3e0e90`.

## Task 6 Implementation

- Plan task: `Task 6: D1 原子 QoS reservation 与七日冷热调度`
- OpenSpec mapping: `2.3` atomic daily budget reservation/consumption; scheduler-only evidence toward `3.3`.
- Stage: `checkoff`
- Implementation base: `3f24898`
- API evidence: generated workerd types expose `D1Database.batch`, `D1DatabaseSession.batch`, `withSession` sequential-consistency semantics and Queue `sendBatch`; Cloudflare D1 documentation confirms one `batch` is a SQL transaction that executes sequentially and rolls the whole sequence back on failure.
- RED evidence: focused suites failed because `d1-budget.ts`, `positiveMod` and the D1 media submission path were absent. The review-fix RED reproduced a committed claim followed by a crash before submission marking: replay returned permanent `reserved`, sent zero Queue messages and left one reserved slot.
- Atomic budget contract: one real D1 batch creates/reuses the daily budget row, claims the stable fingerprinted reservation, updates occupied capacity and reads back the stored result. Replay returns byte-equivalent results; changed payloads reject; concurrent final-slot claims keep total occupied at or below hard limit.
- Submission state machine: a second atomic batch moves `reserved` capacity to `consumed` while acquiring the `reserved → uncertain` Queue-attempt right. Only the caller whose transition reports one applied change may send. Successful sends advance to `submitted`; ambiguous sends and post-send confirmation failures remain fail-closed as `uncertain` without replaying Queue work.
- Scheduler contract: `positiveMod` supports negative IDs; priority is `new_or_changed → hot → cold → retry`; duplicate subjects merge components at their strongest priority; watched subjects cover seven UTC shards exactly once; deferred cold IDs are emitted as a serializable cursor and resume before the next day's shard.
- GREEN evidence: focused budget/planner/coordinator 40/40; storage 63/63 and sync-worker 104/104 before the review fix; both package typechecks after the fix. Full repository tests/typecheck passed before the focused crash-window fix; the external rerun was blocked before process start by the host approval usage limit, not a test failure. OpenSpec strict, frozen lockfile and diff check pass after the fix.
- Review round: spec compliance APPROVED. Initial quality review REJECTED the claim-to-marker crash window; focused RED reproduced it; the atomic transition fix passed 40/40. Fresh quality review APPROVED and independently reran 40/40.
- Scope audit: no Task 7 Workflow orchestration, R2 publication, runtime binding or legacy public-read migration was introduced. OpenSpec `3.3` remains unchecked until Task 7 persists and consumes the scheduler state.
- Task 6 checkoff: plan Steps 1–5 and OpenSpec 2.3 complete.

## Task 7 Implementation

- Plan task: `Task 7: D1 incremental Workflow orchestration`
- OpenSpec mapping: remaining orchestration and no-legacy-write portion of `3.3`.
- Stage: `review-fix`
- Implementation base: `e305553`
- Initial RED evidence: `d1-sync.test.ts` failed with `ERR_MODULE_NOT_FOUND` because `d1-sync.ts` did not exist; the shadow Workflow integration test then failed because the D1 runner was never called.
- Initial GREEN evidence: focused orchestration/Workflow/state-store suite 59/59; sync-worker full package 113/113; sync-worker and storage typecheck; full repository typecheck; scripts 21/21; OpenSpec strict and diff check passed.
- Behavioral evidence: unchanged/one-change D1 row counts, complete-input deletion guard, multi-user composite identity, stable `observedAt`, classified run lifecycle, D1 media reservation counters, hot/cold/retry ordering, cold cursor, bounded one-time stale replan, non-stale error propagation, legacy shadow publication ordering and zero new per-subject KV writes.
- Host limitation: the equivalent all-repository test run passed 383/384; only the isolated Wrangler D1 migration test failed because the sandbox denied localhost listen (`EPERM 127.0.0.1`). A sandbox-external rerun was requested and rejected by the host usage limit. Wrangler dry-runs completed for all four Workers, while attempts to write Wrangler debug logs under user Preferences were sandbox-denied.
- Frozen-lock evidence: the lockfile was unchanged and resolution was skipped. Reinstall recreated `node_modules` but sandbox DNS could not fetch the one missing cached OpenSpec tarball; the required external retry was rejected by the same host usage limit. OpenSpec strict had passed immediately before this host-only dependency disruption.
- Initial implementation commit: `d65bd93f0568ef1d9b80c610894f3e734e0d7280`, pushed.
- Spec review round: `1/2 REJECTED → fixing`.
- Review findings: first-missing rows were prematurely absent from publication input; shadow reservation could submit to the legacy KV-writing media consumer; cold scheduling incorrectly required `next_refresh_at`; Task 7 evidence was not yet tracked.
- Review-fix RED evidence: first/second missing publication, seven-day cold scheduling and calendar-only scheduling regressions were added. The host-limited frozen reinstall initially left the worktree without workspace links; after restoring only ignored local workspace symlinks from the verified pnpm layout, the new focused tests executed normally.
- Review-fix implementation: publication input is derived from the winning post-diff active D1 rows; first missing remains public and confirmed deletion is excluded. Shadow D1 reservation deliberately has no Queue binding and therefore records an uncertain occupied reservation without reaching the legacy media consumer; Task 8 must add the D1-only consumer before submission. Watched media enters the deterministic cold shard/cursor independent of expiry; hot remains expiry-gated. Calendar-only subjects remain media candidates.
- Review-fix GREEN evidence: orchestration/Workflow/state-store focused suite 62/62; sync-worker and storage typecheck; diff check pass.
- Replay hardening rounds: independent review found and the implementation fixed terminal/running response loss, multi-batch collection replay, stale-checkpoint reconciliation, prepared-result schema/hash validation, retry/backoff precedence, monotonic cold-cursor updates, and bounded D1 replay artifacts.
- Replay artifact contract: `sync_runs.result_json` stores only a bounded versioned manifest; payloads are UTF-8 chunked through `app_state`, with per-chunk and aggregate hashes, input identity, byte-length validation, best-effort orphan cleanup, and exact-current-manifest protection. The additive `0002_sync_run_replay_result.sql` migration must be applied before the updated Worker is deployed.
- Real D1 evidence: a 60-row response-loss integration sequence commits 49 rows, replays those 49 as verified no-ops, applies the remaining 11, and only then permits media/publication. A stale persisted checkpoint is CAS-revalidated and cannot publish a losing plan.
- Final GREEN evidence: sync-worker 140/140; storage 38/38; both package typechecks and `git diff --check` pass. Focused replay/scheduling/Workflow/storage suites cover complete input, first/second missing, stable instance replay, malformed artifact terminalization, shadow zero-budget behavior, no legacy per-subject KV writes, seven-day cold rotation, and stale-cursor protection.
- Final review result: spec compliance APPROVED and code quality APPROVED with no blocking findings.
- Implementation/fix commits: `d65bd93`, `0ae6aeb`, `b9df8df`, `0fe0018`, `d43a5a2`, `c30aa8d`, `7ce8924`, and `f978b3a` are pushed.
- Task 7 checkoff: plan Steps 1–4 and OpenSpec 3.3 complete. Stage: `checkoff`.

## Task 8 Implementation

- Plan task: `Task 8: Media Worker D1 authoritative state`.
- OpenSpec mapping: completes the media-consumer/cache-refresh lifecycle evidence for `3.3`; the checkbox was already completed after Task 7 orchestration.
- Stage: `checkoff`.
- Implementation base: `4adc8dd`.
- RED evidence: the initial focused run passed 26/30; the missing D1 media module caused three failures and the V3 Queue path wrote legacy `subject:refresh`, `subject:detail`, `subject:meta`, and `image:status` keys. Review-fix RED cycles covered source/key mismatch, direct D1 failure KV fallback, vanished sources, terminal retry state, V2 compatibility, 24-hour tombstone suppression/renewal, and retry saturation.
- D1/R2 contract: `subject_media` is authoritative for detail/media hashes, source URLs, image refs, NSFW, refresh and retry state. Existing content-addressed image keys and the image R2 bucket remain unchanged. Semantic no-op performs zero D1/R2 writes; a changed requested image performs only its R2 write plus one D1 row.
- Failure contract: image non-success preserves the prior source/key pair and records classified `IMAGE_UNAVAILABLE`; D1 read/upsert failures leave V3 Queue work retryable with zero legacy KV writes; terminal auth failures clear retry state; persisted retry count saturates at tier 3.
- Tombstone contract: confirmed 404 stores a 24-hour D1 boundary, suppresses upstream work before expiry with zero writes, re-probes at the boundary, and renews the boundary on repeated 404. Image source/key pairs and bytes are preserved.
- GREEN evidence: focused 41/41; media-worker 49/49; storage 72/72; media-worker, storage and sync-worker typechecks; `git diff --check`.
- Final review result: spec compliance APPROVED and code quality APPROVED with no remaining blockers.
- Implementation/fix commits: `0ba9590`, `1051407`, `af963fe`, `b810b2f`, and `a3c7859` are pushed.
- Task 8 checkoff: plan Steps 1–4 complete; Task 9 remained untouched.

## Task 9 Implementation

- Plan task: `Task 9: Immutable R2 and pointer-last publication`.
- OpenSpec mappings: `4.2` D1 → R2 put/verify → KV pointer; `4.3` failure injection, replay, old-pointer survival and identical-input zero writes.
- Stage: `checkoff`.
- Implementation base: `8cb0251`.
- RED/GREEN scope: no-op/success ordering, every pre-pointer failure, malformed schema/generation/hash/key, definite and ambiguous KV outcomes, pending replay, D1 response loss, monotonic concurrency, stale pending supersession, no-op races, source freshness and matching-pending adoption were each reproduced before implementation and locked by regression tests.
- Publication protocol: versioned D1 `public:pending`, `public:verified`, `public:write-claim`, and `public:source-watermark`; create-only immutable R2 PUT; full R2 GET plus schema/generation/hash/key validation; exactly one `public:current` KV PUT; D1 verified promotion only afterward.
- Concurrency/replay: D1 cross-key CAS and a 60-second per-attempt lease fence distinct Workflow instances. The only production caller is one durable `step.do` per unique `event.instanceId`; Cloudflare documentation confirms duplicate instance IDs are rejected, restart cancels active steps, and retries do not overlap. Source watermark orders stable `completeInput.observedAt` then publication ID, preventing delayed older runs from allocating after newer no-op runs.
- Pending recovery: failed B can be CAS-superseded by later C only without an active claim; active claims return pending, expired owners are fenced, exact matching content adopts the existing generation/key/timestamp without allocation, and response-loss replay is idempotent.
- Final GREEN evidence: focused 141/141; sync-worker 182/182; storage non-listener 80/80; storage and sync-worker typechecks; `git diff --check`. The only unrun storage listener case is an unchanged migration test blocked by sandbox `listen EPERM 127.0.0.1`; its other migration cases and all Task 9 storage tests passed.
- Final review result: spec compliance APPROVED (including official Workflow execution-model adjudication) and code quality APPROVED with no remaining blockers.
- Implementation/fix commits: `7811700`, `5bf1342`, `7e1c624`, `2c4ed5f`, `4679e97`, `f0fbb0b`, `55a5562`, and `0ca2db3` are pushed.
- Task 9 checkoff: plan Steps 1–5 and OpenSpec 4.2–4.3 complete; no runtime binding/config work was included.

## Task 10 Implementation

- Plan task: `Task 10: Bindings, migration-before-upload and dry-run gates`.
- OpenSpec mappings: `5.1` D1/data-R2 bindings with compatibility bindings retained; `5.2` migration-before-upload and control-plane/config dry-run gates.
- Stage: `checkoff`.
- Implementation base: `47e8873`.
- Verify-before-write evidence: installed Wrangler 4.100.0 help confirms positional D1 binding/database plus `--remote` and `--config`; local config schema confirms D1/R2 binding keys and `migrations_dir`; local generated types confirm `D1Database`/`R2Bucket`; GitHub Actions docs confirm `needs` failure propagation.
- RED evidence: focused config/workflow suite initially passed 18/22; missing binding matrices, runtime env fields, and migration/deploy chain failed. Quality RED later reproduced Sync success without D1/data R2 and Media V3 fallback to legacy KV across Queue/direct/DO paths.
- Binding/deploy contract: sync binds D1 + data R2 + KV + Queue; media binds D1 + image R2; read binds D1 + image/data R2 + KV while handlers remain legacy. Deploy order is resolver → D1 migration → read/media → sync/Workflow → frontend; recovery reporting includes migration failure.
- Runtime fail-closed contract: Sync shadow requires D1/data R2 and always attempts authoritative persistence/publication. Media V3 without D1 remains unacked/retryable and performs zero legacy KV writes; V2 keeps legacy behavior.
- GREEN evidence: focused config gate 41/41; fail-closed sync 19/19; media/DO 36/36; full `pnpm test`, `pnpm typecheck`, and `pnpm build:check`; generated types; YAML parse; placeholder scan; three materialized Wrangler dry-runs all pass.
- Final review result: spec compliance APPROVED and code quality APPROVED with no remaining findings.
- Implementation/fix commits: `6985a9b` and `7d1e82c` are pushed.
- Task 10 checkoff: plan Steps 1–6 and OpenSpec 5.1–5.2 complete; Task 11 remained untouched.

## Task 11 Implementation

- Plan task: `Task 11: Documentation, rollback and repository-constraint synchronization`.
- OpenSpec mapping: `5.3` README/resource/architecture/environment/deployment/rollback documentation.
- Stage: `checkoff`.
- Implementation base: `dc4a192`.
- Truth-table evidence: exact D1/data-R2/image-R2/KV/Queue resources, five primary D1 tables plus reservation helper, 50/100 media budgets, `public:current`, immutable snapshot keys, deploy order, legacy public reads, rollback and secret boundaries were traced to source/config/tests before editing.
- Documentation boundary: current daily `0 20 * * *` schedule is Shanghai 04:00; D1/R2 runs in fail-closed shadow; Read Worker still serves legacy KV; import/cutover/cleanup belongs exclusively to `migrate-public-reads-from-kv`.
- Operational safety: remote migrations precede uploads; rollback deploys one previous compatible full SHA and never reverses migrations or deletes D1/R2/KV data; secret values are not recorded.
- Historical cleanup: the obsolete single-Worker/public `POST /__cron/sync`/four-hour Cron plan is explicitly archived and non-executable. The monorepo design scopes implemented amendments and records current analytics no-output behavior.
- GREEN evidence: docs/config 32/32; strict OpenSpec; stale-claim scan; `git diff --check`.
- Final review result: documentation spec/truth APPROVED and quality APPROVED with no remaining findings; durable repository rules correctly remained unchanged.
- Implementation/fix commits: `626518a`, `8944443`, and `528c937` are pushed.
- Task 11 checkoff: plan Steps 1–4 and OpenSpec 5.3 complete; production evidence and Task 12 remain pending.

## Task 12 Verification-ready Implementation

- Plan task: `Task 12: 完整验证、生产 migration 与 shadow release`, Steps 1–4 only.
- Stage: `implemented-pending-independent-review`.
- Verified source SHA: `38dd213eed4da58b6deef1104c9181528fe6654e`.
- Full gates: repository tests 514/514; all nine workspace typechecks; all four
  Worker build checks; strict OpenSpec; and `git diff --check` pass.
- Focused acceptance evidence: 271/271 across collection diff, D1 state/budget,
  D1 orchestration, R2 publication, refresh planning, Workflow, D1 media,
  Media Worker, Read Worker, and deploy-config suites.
- Materialized config evidence: canonical fake D1/KV IDs, executable
  no-placeholder and exact binding-matrix assertions, and all four
  read/media/sync/frontend Wrangler dry-runs pass. Sync exposes Workflow, D1,
  data R2, KV, Queue, and Durable Object; Read and Media match their intended
  compatibility matrices; Frontend exposes only Read/Sync services plus build
  metadata.
- Requirement audit: every one of the 16 OpenSpec added requirements and every
  one of the eight Design §10 criteria has source plus executable evidence;
  fresh verifier found no defect requiring a RED/fix cycle.
- Public-read boundary: Read Worker handlers still use legacy KV; D1/data-R2
  bindings remain unused by handlers.
- Setup investigation: one discarded dry-run setup incorrectly supplied
  frontend-only build metadata to Sync, duplicating `[vars]`. The deploy
  workflow proves the variables are frontend-scoped; production-mirroring
  rematerialization passed without repository changes.
- Pending boundary: no remote migration, `dev` integration, deploy, live metric
  query, shadow comparison, public smoke test, OpenSpec 6.1/6.2 checkoff, build
  guard, or Comet `verify` transition was performed.
- OpenSpec 6.1 and 6.2 deliberately remain unchecked for coordinator review and
  production evidence.

## Final Review V3 Compatibility Fix

- Stage: full local verification GREEN; ready for coordinator handoff.
- Review base: `6be4fd8eb94d065d952ef29896d6575de863f4fc`.
- Root cause: live Workflow already produced V3, but Task 8 routed every V3 to
  D1-only media state while Read and the live planner still consumed legacy
  subject/image KV. Successful live refreshes were therefore publicly stale
  and planned again.
- Contract correction: V3 remains the live legacy-compatible job. New V4 is
  the only D1-only discriminator and is emitted only by D1 incremental media
  planning. Live reservation rejects V4; D1 reservation accepts only V4.
- RED evidence: the integrated live Workflow → Media Queue → legacy Read →
  planner regression failed because Read returned episode count `1` instead of
  refreshed `24`.
- Focused GREEN evidence: 117/117 composition, Media, D1 media/orchestration,
  reservation, validation, and planner tests; storage/media/sync typechecks.
- Full GREEN evidence: 519/519 repository tests; all nine workspace typechecks;
  all four build checks; exact materialized binding-matrix/no-placeholder
  assertion; four Wrangler 4.100.0 materialized dry-runs; strict OpenSpec; and
  `git diff --check`.
- Safety evidence: V4 without D1 stays unacked/retryable across Queue/direct/DO
  and performs zero legacy per-subject KV writes. D1 request fingerprints
  include the versioned job payload and reject V4/V3 replay substitution.
- Boundary: no remote migration, deployment, OpenSpec 6.1/6.2 checkoff, Task 12
  production action, build guard, or Comet transition was performed.
