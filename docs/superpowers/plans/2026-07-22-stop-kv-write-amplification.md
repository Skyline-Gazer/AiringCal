---
change: stop-kv-write-amplification
design-doc: docs/superpowers/specs/2026-07-22-stop-kv-write-amplification-design.md
base-ref: 6281572784cd93e242589656453648f83909705e
---

# Stop KV Write Amplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop unchanged daily syncs from generating per-subject KV writes or media messages while preserving daily public snapshot publication and a hard daily media ceiling of 100.

**Architecture:** The Workflow derives component-level refresh candidates from existing KV state before enqueue, orders them deterministically, and reserves a shared UTC-day budget through a narrow coordinator interface. The media consumer compares normalized stored and proposed state before writing. Cron and operational documentation then move from four-hour to daily scheduling.

**Tech Stack:** TypeScript 6, Node test runner through `tsx --test`, Cloudflare Workers/Workflows/Queues/KV/Durable Objects, Wrangler 4, pnpm workspace.

## Global Constraints

- Follow `docs/rules/docs-sync.md`: verify every CLI flag/config key/API before writing it, update documentation with code, and commit/push every atomic change.
- Check `docs/example/api/bgm-api.json` before changing any bgm.tv request; this change should not alter those calls.
- Use strict TDD: observe the intended failure before production-code edits, then make the smallest green implementation and refactor only while green.
- Public HTTP response contracts and existing KV read keys remain unchanged.
- Scheduled sync is once daily at 04:00 Asia/Shanghai; manual and scheduled live runs share one UTC-day soft limit 50 and hard limit 100; shadow reserves and enqueues nothing.

---

### Task 1: Observable unchanged-cache regression baseline

**Files:**
- Modify: `apps/sync-worker/src/workflow.test.ts`
- Modify: `openspec/changes/stop-kv-write-amplification/tasks.md`

**Interfaces:**
- Consumes: existing `MockKV`, `FakeStep`, `workflowEnv`, `runSyncWorkflow`.
- Produces: reusable KV PUT classification helpers and a 659-subject full-path regression test that later planner tasks must satisfy.

- [ ] **Step 1: Extend the KV/Queue test doubles without changing production code**

Add helpers to `MockKV` that return PUTs whose keys start with `subject:refresh:`, `subject:meta:`, or `image:status:` and a helper that seeds complete unexpired detail/meta/image/refresh records for a subject. Keep Queue observation through the existing `queueMessages` array.

- [ ] **Step 2: Write the failing 659-subject regression**

Create a test named `unchanged 659-subject workflow enqueues no media and performs no subject KV PUTs`. Stub 14 collection pages totaling 659 unique subjects plus an empty calendar, seed every subject with complete source-matching state whose `cached_at` is before `nextSubjectRefreshAt`, execute a new live Workflow instance, and assert:

```ts
assert.equal(queueMessages.length, 0)
assert.deepEqual(kv.subjectPuts(), [])
assert.equal((kv.values.get('snapshot:active') as any).instance_id, 'unchanged-659')
```

- [ ] **Step 3: Run the exact test and verify RED**

Run: `pnpm -F @airing-cal/sync-worker test -- --test-name-pattern="unchanged 659-subject"`

Expected: FAIL because the current Workflow creates 659 full-component jobs and Queue receives messages. Confirm the failure is an assertion mismatch, not fixture or pagination setup failure.

- [ ] **Step 4: Commit and push the red regression**

Run `git diff --check`, stage only `workflow.test.ts` plus the corresponding completed 1.1/1.2 checkboxes in `tasks.md`, commit as `test: expose unchanged sync KV amplification`, and push the current branch. Preserve the failing-test evidence in the implementation log/commit body because the branch is intentionally red at this TDD checkpoint.

### Task 2: Bounded component planner and shared UTC-day budget

**Files:**
- Create: `apps/sync-worker/src/refresh-planner.ts`
- Create: `apps/sync-worker/src/refresh-planner.test.ts`
- Modify: `apps/sync-worker/src/workflow-core.ts`
- Modify: `apps/sync-worker/src/workflow.test.ts`
- Modify: `apps/sync-worker/src/snapshot-coordinator.ts`
- Modify: `apps/sync-worker/src/snapshot-coordinator.test.ts`
- Modify: `openspec/changes/stop-kv-write-amplification/tasks.md`

**Interfaces:**
- Consumes: `nextSubjectRefreshAt`, `subjectDetailKey`, `subjectMetaKey`, `imageStatusKey`, `subjectRefreshKey`, `MediaRefreshComponent`, `MediaRefreshJobV3` from `@airing-cal/storage`.
- Produces: `planSubjectRefresh(input, cached, now): RefreshCandidate | null`, `selectRefreshCandidates(candidates, utcDay, limits): RefreshSelection`, and the existing `SNAPSHOT_COORDINATOR` Durable Object endpoint `POST /reserve-media` accepting `{ date, requested, allow_over_soft }` and returning `{ granted, consumed, soft_limit, hard_limit }`.

- [ ] **Step 1: Write planner RED tests**

In `refresh-planner.test.ts`, cover complete/unexpired => `null`, missing detail => `['detail','meta']`, changed image source => only the changed image component, exact `nextSubjectRefreshAt` boundary => due, hot before cold before retry ordering, deterministic `subject_id % 7` cold membership, 80 ordinary => 50 selected, and 60 new/changed => 60 selected but 101 => 100.

- [ ] **Step 2: Run planner tests and verify RED**

Run: `pnpm -F @airing-cal/sync-worker test -- --test-name-pattern="refresh planner"`

Expected: module-not-found or missing-export failure for `refresh-planner.ts`.

- [ ] **Step 3: Implement the pure planner and make it GREEN**

Define explicit cached-state and priority types in `refresh-planner.ts`. Use `nextSubjectRefreshAt(subjectId, cachedAt) <= now`; do not introduce another TTL formula. Sort by numeric priority then subject ID. Return counters `{ candidates, selected, deferred, by_priority }` with the selected component arrays. Run the focused planner tests until all pass.

- [ ] **Step 4: Write budget coordinator RED tests**

In `snapshot-coordinator.test.ts`, use its existing in-memory Durable Object storage double and assert sequential scheduled/manual reservations share `2026-07-22`, grants never take consumed above 100, a different UTC date resets count, and zero-request shadow logic never calls the coordinator.

- [ ] **Step 5: Run budget tests and verify RED**

Run: `pnpm -F @airing-cal/sync-worker test -- --test-name-pattern="media budget"`

Expected: `/reserve-media` is unimplemented or returns the wrong status/body.

- [ ] **Step 6: Implement the minimal serialized budget coordinator**

Extend the existing `SnapshotCoordinator` with storage record `{ date: string; consumed: number }` and a `/reserve-media` handler. Durable Object request serialization provides the required atomic boundary. Clamp grants to remaining hard capacity and allow crossing 50 only when `allow_over_soft` is true. Do not add another binding, class, migration, or KV key.

- [ ] **Step 7: Integrate planning into Workflow with a new RED test first**

Update `workflow.test.ts` before `workflow-core.ts` so the live-run test expects component-specific jobs, shared-budget requests, zero media work for shadow, and snapshot commit despite zero grant. Verify RED against the old unconditional planner.

- [ ] **Step 8: Replace unconditional full jobs with bounded planning**

In `workflow-core.ts`, keep KV operations bounded per Workflow step: read each chunk's detail/meta/image/refresh state, call the pure planner, stage only candidates, reserve once for the deterministic ordered selection, and enqueue only granted jobs. Do not write `subject:refresh:*` while planning. Ensure live snapshot commit no longer depends on media candidates existing or budget being available; Queue transport failures keep current safety semantics unless the delta spec requires otherwise.

- [ ] **Step 9: Run focused and package tests GREEN**

Run:

```bash
pnpm -F @airing-cal/storage test
pnpm -F @airing-cal/sync-worker test
pnpm -F @airing-cal/sync-worker typecheck
```

Expected: all pass, including the 659 regression; no Workflow step exceeds the existing external-operation assertions.

- [ ] **Step 10: Commit and push bounded planning atomically**

Mark tasks 2.1/2.2 complete, run `git diff --check`, stage only planner/budget/Workflow/config/type/task files, commit as `fix: bound daily media refresh planning`, and push.

### Task 3: Media consumer semantic compare-before-write

**Files:**
- Modify: `apps/media-worker/src/media-worker.test.ts`
- Modify: `apps/media-worker/src/subject-refresh-coordinator.test.ts`
- Modify: `apps/media-worker/src/index.ts`
- Modify: `apps/media-worker/src/subject-refresh-coordinator.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/index.test.ts`
- Modify: `openspec/changes/stop-kv-write-amplification/tasks.md`

**Interfaces:**
- Consumes: existing `processJob`, `KVStorage`, subject detail/meta/image/refresh records.
- Produces: `putJsonIfChanged(storage, key, next, normalize): Promise<boolean>` (or equivalently named shared helper) whose equality excludes observation-only timestamps but retains semantic timestamps when content actually changes.

- [ ] **Step 1: Write storage-helper RED tests**

Add tests proving a missing key writes once, an identical normalized value writes zero times, and a semantic field change writes once. The test double must count concrete `put` calls.

- [ ] **Step 2: Run storage tests and verify RED**

Run: `pnpm -F @airing-cal/storage test -- --test-name-pattern="unchanged"`

Expected: missing helper/export failure.

- [ ] **Step 3: Implement the minimal compare helper and make storage GREEN**

Use stable object comparison for the explicitly normalized record supplied by the caller; do not globally strip fields or change existing `KVStorage.put` semantics. Return whether a PUT occurred.

- [ ] **Step 4: Write consumer RED tests for reusable media**

In `media-worker.test.ts`, seed matching detail metadata and both cached image statuses, execute a V3 job whose source URLs match, and assert no `subject:meta:*`, `image:status:*`, or terminal `subject:refresh:*` PUT. Add separate tests proving changed source, failure/backoff, and tombstone transitions still write. In coordinator tests, assert duplicate/obsolete jobs remain no-op.

- [ ] **Step 5: Run media tests and verify RED**

Run: `pnpm -F @airing-cal/media-worker test -- --test-name-pattern="unchanged|reusable"`

Expected: FAIL with observed redundant PUT keys/counts.

- [ ] **Step 6: Apply compare-before-write at each consumer persistence boundary**

Normalize and compare detail metadata, subject metadata, each image status, and refresh terminal/error state immediately before their existing PUT sites. Preserve the stored value when the public/source/error/tombstone semantics are unchanged. Do not suppress a required running-to-failed, missing-to-cached, changed-source, retry, or tombstone transition.

- [ ] **Step 7: Run focused tests GREEN and refactor**

Run:

```bash
pnpm -F @airing-cal/storage test
pnpm -F @airing-cal/media-worker test
pnpm -F @airing-cal/media-worker typecheck
```

Expected: all pass with no warnings or changed public image references.

- [ ] **Step 8: Commit and push consumer zero-write behavior**

Mark task 2.3 complete, run `git diff --check`, commit only storage/media tests, implementation, and task checkbox as `fix: skip unchanged media KV writes`, then push.

### Task 4: Daily Cron, observability, documentation, and release gates

**Files:**
- Modify: `apps/sync-worker/src/scheduled-trigger.test.ts`
- Modify: `apps/sync-worker/src/workflow.test.ts`
- Modify: `apps/sync-worker/wrangler.toml`
- Modify: `packages/worker-common/src/deploy-config.test.ts`
- Modify: `README.md`
- Modify: relevant architecture/deployment documents found by `rg -n "0 \*/4|每四小时|four.hours|refresh_jobs" README.md docs .github apps packages`
- Modify: `openspec/changes/stop-kv-write-amplification/tasks.md`

**Interfaces:**
- Consumes: Workflow result/run state and existing scheduled trigger.
- Produces: aggregate run fields/logs for `refresh_candidates`, `refresh_selected`, `refresh_deferred`, and `avoided_writes`; checked-in daily Cron configuration and matching operational documentation.

- [ ] **Step 1: Verify Cron configuration before editing**

Run `pnpm exec wrangler deploy --help`, inspect installed Wrangler config types/source for `[triggers].crons`, and confirm Cloudflare Cron uses UTC. Record the verified daily expression corresponding to 04:00 Asia/Shanghai; do not infer an unverified config key.

- [ ] **Step 2: Write RED tests for schedule and aggregate counters**

Change `deploy-config.test.ts` to require the verified daily expression and forbid `0 */4 * * *`. Add Workflow assertions for candidates/selected/deferred/avoided-write counters on unchanged, soft-limited, and hard-limited runs. Run the focused tests and confirm failure against current config/result shape.

- [ ] **Step 3: Implement daily schedule and aggregate observability**

Update only the verified Wrangler Cron value. Extend `SyncRun`/Workflow output with aggregate counters without adding per-subject metric keys; update counter state only at existing bounded run-write points.

- [ ] **Step 4: Update synchronized documentation and constraints**

Use `rg` to find every four-hour schedule and unconditional-refresh statement. Update README, architecture, deployment/runbook, resource/environment tables, and health/metric descriptions to document daily 04:00 Asia/Shanghai, UTC budget sharing, soft 50/hard 100, seven-day cold shard, shadow zero-enqueue, and unchanged zero-write behavior. Do not document D1/R2 runtime behavior in this stopgap change.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
pnpm -F @airing-cal/sync-worker test
pnpm -F @airing-cal/media-worker test
pnpm -F @airing-cal/storage test
pnpm -F @airing-cal/worker-common test
pnpm typecheck
pnpm test
pnpm build:check
./node_modules/.bin/openspec validate stop-kv-write-amplification --strict
git diff --check
```

Expected: every command exits 0. If a test/build behaves unexpectedly, stop and apply the systematic-debugging skill before changing production code.

- [ ] **Step 6: Commit and push schedule/docs/verification atomically**

Mark tasks 3.1–3.3 and 4.1 complete. Commit the verified schedule, counters, tests, documentation, and task state as `fix: run bounded sync daily`, then push.

- [ ] **Step 7: Prepare production deployment evidence**

After Comet verify/review gates pass, deploy the exact pushed SHA through the repository's existing deployment workflow. Record the Workflow instance, deployed SHA, immediate API/health smoke checks, and Cloudflare KV metric baseline. Leave task 4.2 incomplete until the 24-hour KV write curve is actually observed below 100 and one scheduled run succeeds; do not claim acceptance from a dry-run.
