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
- Stable observation contract: `assembleFullFetch` requires and returns an explicit observation. Workflow passes the persisted `SyncRun.started_at` and writes it into the prepared staging record; a forced prepare-step retry proves the value remains identical. Task 6 integration MUST pass this `completeInput.observedAt` unchanged into `planCollectionDiff` rather than calling `Date.now`.
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
