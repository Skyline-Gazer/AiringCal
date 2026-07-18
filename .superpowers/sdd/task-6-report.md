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

## User-authorized extra focused fix round

The remaining review finding was technically confirmed: `withSubjectDetail` and `mergeCollections` can copy canonical detail fields into snapshots, while the active-tombstone Read projection previously removed only episode and rating fields. Once persisted in a snapshot, the Read worker cannot distinguish old detail values from safe source values.

Extra-round RED evidence:

- The first sandboxed `CI=true pnpm -F @airing-cal/read-worker test` attempt was invalid because `tsx` could not create its IPC pipe (`listen EPERM`).
- Rerunning outside the sandbox produced the effective RED: read-worker 29/31. The enriched collection and calendar regressions both failed because the response still contained `name: 'Stale name'` instead of `undefined`.

Extra-round implementation and GREEN evidence:

- During an active not-found tombstone only, `projectSnapshotEntry` now also removes snapshot-carried `name`, `name_cn`, `summary`, and `date` alongside the existing episode/rating fields.
- The regressions prove collection `subject_id`, calendar `id`/`subject_id`, collection `ep_status`, and conservative `nsfw: true` remain available; non-tombstone projection is unchanged.
- Read-worker passed 31/31 after the minimal implementation.
- Complete tests passed: media 23/23, read 31/31, sync 40/40, domain 28/28, storage 8/8 (130/130).
- Typechecks passed for media, read, sync, domain, and storage.
- Build checks passed for media, read, and sync, including current Wrangler types and dry-run deploys.
- `git diff --check` passed.

## User-authorized second extra fix round

The two new Important findings were independently verified and fixed one behavior at a time.

First-404 Media RED/GREEN evidence:

- A new normal V3 `detail` + `meta` + image-components regression received a confirmed subject-detail 404 while carrying stale job image URLs and an existing image status.
- Effective RED: media-worker passed 23/24. The same job fetched both stale image URLs after the subject 404.
- The minimal fix re-reads the authoritative metadata after a null detail result. A newly active confirmed-not-found tombstone completes a versioned refresh as `ok` and returns before image download, R2/index writes, or image-status replacement.
- Focused GREEN: media-worker passed 24/24. The regression proves the only upstream call is the subject endpoint, R2 has no writes, the prior image status is unchanged, and the refresh is not falsely marked failed.

Exact-expiry Read RED/GREEN evidence:

- Collection and calendar regressions were advanced to exactly `expires_at` with stale canonical fields, rating/episode fields, and residual cached detail still present.
- Effective RED: read-worker passed 29/31. Calendar returned old episode detail and collections returned stale snapshot rating at exact expiry.
- The domain now separates `isActiveNotFoundSubjectMeta(meta, now)`, used only for refresh throttling, from `isConfirmedNotFoundSubjectMeta(meta)`, which remains authoritative for Read suppression until a successful reprobe replaces metadata.
- Focused GREEN: read-worker passed 31/31 and domain passed 28/28. Existing media recovery still reprobes at exact expiry and replaces the tombstone after success.

Second-extra-round final verification:

- Complete tests passed: media 24/24, read 31/31, sync 40/40, domain 28/28, storage 8/8 (133/133).
- Typechecks passed for media, read, sync, domain, and storage.
- Build checks passed for media, read, and sync; Wrangler types were current and all three dry-run deploys completed.
- `git diff --check` passed.
- The first sandboxed focused test attempt was invalid because `tsx` could not create its IPC pipe (`listen EPERM`); all effective RED and GREEN evidence above came from the permitted outside-sandbox reruns.

## User-authorized third extra fix round

The three image and recovery findings were verified against the public projection, V3 job, and scheduled refresh-plan contracts, then fixed in separate RED→GREEN cycles.

Confirmed-not-found Read image RED/GREEN evidence:

- Collection and calendar exact-expiry fixtures now contain both snapshot image fields and independently cached image status.
- The first sandboxed attempt was invalid because `tsx` could not create its IPC pipe (`listen EPERM`). The permitted rerun produced the effective RED: read-worker 29/31; both endpoints reattached cached image refs while the confirmed tombstone was still authoritative.
- The minimal fix removes snapshot `images`/`image_status` in the tombstone projection and prevents both hydration paths from reattaching cached status until successful recovery replaces metadata.
- Focused GREEN: read-worker 31/31.

Expired image-only Media RED/GREEN evidence:

- Regressions cover exact expiry followed by a repeated 404 and by successful recovery. Both jobs request only `image_common`, carry a stale job URL, and retain a fresh residual detail cache entry.
- Initial effective RED: media-worker 24/26; both cases fetched the stale job URL without calling `/v0/subjects/23080`. After routing image-only work into the detail path, the strengthened residual-cache fixtures produced a second effective RED at 24/26 because cached `residual.jpg` still bypassed the required upstream reprobe.
- The minimal final fix forces any persistent confirmed-not-found metadata through a direct upstream detail reprobe once its active TTL ends, bypassing residual detail cache. A repeated 404 renews the tombstone and returns before image work; successful recovery replaces metadata/detail and uses the recovered detail image URL.
- Focused GREEN: media-worker 26/26. The recovery test proves the stale URL is never fetched and the repeated-404 test proves image status and R2 remain unchanged.

Collection-only Sync recovery RED/GREEN evidence:

- A scheduled-sync regression uses a collection-only subject with complete cached images and confirmed-not-found metadata, testing active TTL and exact expiry independently.
- Effective RED: sync-worker 40/41; the expired case queued zero recovery jobs while the active case remained correctly suppressed.
- The minimal fix retains full `SubjectMeta` in refresh planning. `shouldQueueMedia` now suppresses active tombstones and forces expired confirmed tombstones before ordinary metadata/image completeness checks.
- Focused GREEN: sync-worker 41/41; active TTL queues zero jobs and exact expiry queues one full V2 detail/meta/image recovery job.

Third-extra-round final verification:

- Complete tests passed: media 26/26, read 31/31, sync 41/41, domain 28/28, storage 8/8 (134/134).
- Typechecks passed for media, read, sync, domain, and storage.
- Build checks passed for media, read, and sync; Wrangler types were current and all three dry-run deploys completed.
- `git diff --check` passed.

## User-authorized fourth extra fix round

The residual-detail snapshot finding was verified at the exact TTL boundary and fixed without changing recovery scheduling.

Residual-detail Sync RED/GREEN evidence:

- The regression preloads a fresh residual detail entry to model best-effort deletion failure, retains persistent confirmed-not-found metadata at `now === expires_at`, and runs scheduled Sync.
- The first sandboxed focused test attempt was invalid because `tsx` could not create its IPC pipe (`listen EPERM`). The permitted rerun produced the effective RED: sync-worker 41/42; the collection snapshot republished `name: 'Residual'` from the stale cache.
- Both Sync detail loaders now use `isConfirmedNotFoundSubjectMeta` when deciding whether cached detail may enter a snapshot. TTL remains exclusive to `shouldQueueMedia`, so exact expiry still schedules one full recovery job while residual canonical, episode, and rating fields remain absent from collection and calendar snapshots.
- Focused GREEN: sync-worker 42/42. The regression also proves scheduled Sync does not perform the subject reprobe itself; Media remains the serialized recovery path. Because the persisted snapshot never contains the residual values, successful Media recovery and subsequent Read suppression removal cannot reveal the deleted detail from that snapshot.

Fourth-extra-round final verification:

- Complete tests passed: media 26/26, read 31/31, sync 42/42, domain 28/28, storage 8/8 (135/135).
- Typechecks passed for media, read, sync, domain, and storage.
- Build checks passed for media, read, and sync; Wrangler types were current and all three dry-run deploys completed.
- `git diff --check` passed.

## User-authorized fifth extra fix round

The deployment compatibility finding was verified against the exact pre-Task-6 source at base commit `bf171585902d63f32ebfffd8224167c5777cce69`. Its persisted missing-subject metadata was `{ subject_id, exists: false, nsfw: true, checked_at, reason: 'not_found_or_restricted' }` with no `expires_at` field.

Legacy tombstone compatibility RED/GREEN evidence:

- The first sandboxed test attempt was invalid because `tsx` could not create its IPC pipe (`listen EPERM`). The permitted rerun produced the effective RED: domain 28/29; `isConfirmedNotFoundSubjectMeta` returned false for the verified legacy shape.
- The shared metadata type now accepts the legacy reason and an absent `expires_at`. The confirmed predicate recognizes both persisted legacy and current `not_found` records, while the active-TTL predicate accepts only current `not_found` records with a future numeric expiry.
- This keeps legacy records fail-closed in Read and Sync but does not suppress refresh forever: Sync excludes residual detail and immediately queues recovery; Media forces a direct subject probe even for image-only work, bypassing residual detail and job image URLs. A repeated 404 migrates metadata to the current 24-hour tombstone. Existing successful-recovery coverage proves a successful probe replaces metadata with `exists: true`; transient failures leave the prior confirmed metadata authoritative.
- Focused GREEN passed: domain 29/29, read 32/32, sync 43/43, and media 27/27.

Fifth-extra-round final verification:

- Complete Task 6 tests passed: media 27/27, read 32/32, sync 43/43, domain 29/29, storage 8/8 (139/139).
- Typechecks passed for media, read, sync, domain, and storage.
- Build checks passed for media, read, and sync; Wrangler types were current and all three dry-run deploys completed.
- `git diff --check` passed.

## User-authorized sixth extra fix round

The Media fail-closed finding was verified for the persisted legacy tombstone shape and fixed without changing transient retry or successful recovery behavior.

Non-404 forced-reprobe RED/GREEN evidence:

- A legacy confirmed tombstone, residual detail, cached image status, and stale V3 image-only job were combined with a forced subject reprobe returning HTTP 403.
- The first sandboxed focused test attempt was invalid because `tsx` could not create its IPC pipe (`listen EPERM`). The permitted rerun produced the effective RED: media-worker 27/28; after the subject API call, the job fetched its stale image URL.
- The minimal fix changes the post-fetch guard to stop whenever authoritative metadata remains any confirmed-not-found shape, rather than only a current active-TTL tombstone. The versioned refresh completes as `ok`, matching the existing terminal confirmed-tombstone semantics.
- Focused GREEN: media-worker 28/28. The regression proves only the subject endpoint is called, the confirmed metadata and previous image status remain unchanged, R2 receives no writes, and no stale job or residual-detail image URL is processed.

Sixth-extra-round final verification:

- Complete Task 6 tests passed: media 28/28, read 32/32, sync 43/43, domain 29/29, storage 8/8 (140/140).
- Typechecks passed for media, read, sync, domain, and storage.
- Build checks passed for media, read, and sync; Wrangler types were current and all three dry-run deploys completed.
- `git diff --check` passed.
