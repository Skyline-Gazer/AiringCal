# Task 6 Report

## Status

PASS — confirmed missing subjects are conservatively tombstoned for exactly 24 hours without weakening transient stale-on-error or the per-subject generation coordinator.

## TDD evidence

The first sandboxed test attempt was not a valid RED because `tsx` could not create its IPC pipe (`listen EPERM`). The tests were rerun outside the sandbox and produced the following effective RED evidence:

- `CI=true pnpm -F @airing-cal/domain test` — 26/27 passed; `subjectMetaFromNotFound` lacked `expires_at` and still emitted `not_found_or_restricted`.
- `CI=true pnpm -F @airing-cal/storage test` — 7/8 passed; a confirmed `getSubject` null incorrectly returned stale detail.
- `CI=true pnpm -F @airing-cal/media-worker test` — 20/21 passed; stale detail prevented the confirmed 404 from producing the required tombstone.
- `CI=true pnpm -F @airing-cal/read-worker test` — 29/30 passed; active tombstone hydration still projected episode/rating data from old detail.

After the minimal implementation, the combined GREEN command passed all four complete suites: media 21/21, read 30/30, domain 27/27, storage 8/8; 86/86 total.

## Implementation

- `SubjectMeta` now has explicit `expires_at: number | null`; confirmed not-found metadata is `{ exists: false, nsfw: true, reason: 'not_found', checked_at, expires_at: checked_at + 86400 }`.
- `getCachedSubjectDetail` distinguishes confirmed null from thrown transient errors: null is returned to the caller, while network/429/5xx exceptions retain stale-on-error fallback.
- The existing per-subject `processJob` path checks active tombstones before subject or image upstream work. A valid tombstone ends the job without upstream calls; an expired tombstone permits normal reprobe.
- Confirmed 404/null writes the tombstone and deletes the old `subjectDetailKey`. A successful reprobe replaces both metadata and detail.
- Read calendar hydration ignores old detail while the tombstone is active and applies conservative `nsfw: true` from metadata.
- Existing Durable Object coordinator tests continue to prove older generations are rejected before media state can be overwritten.

## Files

- `apps/media-worker/src/index.ts`
- `apps/media-worker/src/media-worker.test.ts`
- `apps/read-worker/src/index.ts`
- `apps/read-worker/src/collections.test.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/calendar.test.ts`
- `packages/domain/src/snapshot.test.ts`
- `packages/storage/src/index.ts`
- `packages/storage/src/index.test.ts`

## Verification

- Four complete package test suites — PASS, 86/86.
- `CI=true pnpm -F @airing-cal/media-worker typecheck` — PASS.
- `CI=true pnpm -F @airing-cal/read-worker typecheck` — PASS.
- `CI=true pnpm -F @airing-cal/domain typecheck` — PASS.
- `CI=true pnpm -F @airing-cal/storage typecheck` — PASS.
- `CI=true pnpm -F @airing-cal/media-worker build:check` — PASS, Wrangler types current and dry-run deploy completed.
- `CI=true pnpm -F @airing-cal/read-worker build:check` — PASS, Wrangler types current and dry-run deploy completed.
- `git diff --check` — PASS.
- Scope diff reviewed before staging; implementation commit `172192f` contains only the nine files listed above.

## Self-review and concerns

- The 23:59 boundary uses `now < expires_at`; reprobe occurs after expiry and the recovery test advances beyond 24 hours.
- Network, 429, and 5xx cases do not write `reason: not_found` and preserve stale detail.
- Tombstone suppression covers image-only upstream work as well as subject detail because it occurs before either path.
- No source, test, plan, tasks, README, or coordinator progress file is changed by this report-only follow-up.
- The worktree retains an unrelated coordinator-owned modification to `openspec/changes/remediate-full-repository-audit/.comet/subagent-progress.md`; it was not modified or staged by Task 6.

## Review fix round 1

The thorough review findings were fixed with a second RED→GREEN cycle:

- Domain now exports the type-safe `isActiveNotFoundSubjectMeta(meta, now)` predicate. Media, Read, and Sync use the same exact `now < expires_at` boundary; a domain test proves `now === expires_at` is inactive and the media recovery test reprobes at that exact second.
- Sync reads subject meta before both upstream/cached calendar detail loading and stored collection detail loading. An active tombstone suppresses the upstream subject call and excludes residual detail from both collection and calendar snapshots, even if the detail key remains present.
- Read removes snapshot-carried `rating`, `eps`, `eps_count`, and `total_episodes` under an active tombstone for both collection and calendar responses, while retaining collection progress such as `ep_status` and forcing conservative `nsfw: true`.
- Media tests prove an active tombstone suppresses both subject and image upstream work for an image-only job. Tombstone metadata remains authoritative when stale-detail deletion fails: deletion is best-effort after the fail-closed meta write.

Review-fix RED evidence:

- Domain failed to load because `isActiveNotFoundSubjectMeta` was not exported.
- Read passed 29/31; enriched collection/calendar snapshot fields remained visible.
- Sync passed 39/40; the active tombstone still allowed one `/v0/subjects/23080` request.
- Media's exact-boundary, image-only, and delete-failure tests passed immediately against the existing control-flow ordering; the shared-helper replacement and best-effort deletion retained those behaviors.

Review-fix GREEN and final verification:

- Complete tests: media 23/23, read 31/31, sync 40/40, domain 28/28, storage 8/8 (130/130).
- Typechecks: media, read, sync, domain, and storage all PASS.
- Build checks: media, read, and sync Wrangler type checks and dry-run deploys all PASS.
- `git diff --check` PASS; scope contains only Task 6 code/tests plus this report. Coordinator-owned progress remains unstaged and untouched.
