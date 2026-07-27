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
- Stage: `review-pending`
- Implementation base: `f671fb3`
- RED evidence: focused canonical/snapshot suite failed because `canonical-json.ts` and `public-snapshot.ts` did not exist.
- GREEN evidence: focused 21/21; storage 23/23; domain 40/40; package and full-repository typecheck/test/build checks pass.
- Canonical contract: recursive plain-object key ordering, array order preservation, explicit `undefined` to `null`, UTF-8 SHA-256, lowercase 64-character hex and non-finite number rejection.
- Collection hash scope: detects rate, tags, comment, collection type, episode/volume progress, public `updated_at`, and explicit public subject projection changes while excluding runtime observation/publication fields and opaque subject keys.
- Snapshot contract: groups all five collection types, derives summary, retains calendar/image/NSFW projections, excludes envelope fields from content hash, deeply validates every nested field and summary invariant, verifies its own hash, rejects unknown schema/collection types and produces the exact immutable object key.
- Scope audit: no collection diff, R2 publication, Worker runtime binding or legacy read-path change was introduced.
- Checkoff: OpenSpec 4.1 is complete. OpenSpec 2.2 remains open because Task 5 still must provide the typed D1 adapter and remaining row-mapping evidence.
- Review/fix round: `2/2 REJECTED → fixed; fresh re-review pending`.
- Review-fix RED evidence: 9/17 focused assertions failed for public timestamp hashing, subject allowlisting, publication envelope, unknown collection types and deep/self-consistent snapshot parsing; a second RED cycle failed 2/9 for invalid envelope values and bucket/identity invariants.
- Review-fix implementation: `upstream_updated_at` now participates as public `updated_at`; subject object/JSON use an explicit OpenAPI-backed public allowlist; snapshots carry validated `published_at`; the async parser validates exact nested contracts, five buckets, counters, image/NSFW fields and lowercase SHA-256 before recomputing the stable payload hash.
- First review-fix GREEN evidence: focused 19/19; storage 23/23; domain 38/38; full repository test/typecheck/build check; frozen lockfile; OpenSpec strict and diff check all pass.
- Second review-fix RED evidence: 2/21 focused assertions failed because `subject_type` did not affect the business hash and the builder accepted typed inputs that the parser rejected.
- Second review-fix implementation: `CollectionContentInput` now explicitly requires and hashes top-level `subject_type`; builder and parser share the same complete structure/semantic validator, so invalid rates, image hashes, calendar identities and other contract violations cannot be emitted.
- Second review-fix GREEN evidence: focused 21/21; storage 23/23; domain 40/40; full repository test/typecheck/build check; frozen lockfile; OpenSpec strict and diff check all pass.
