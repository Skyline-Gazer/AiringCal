---
comet_change: stop-kv-write-amplification
role: technical-design
canonical_spec: openspec
---

# Stop KV Write Amplification — Technical Design

## Context

The live sync currently runs every four hours and plans a full media job for every collection and calendar subject. The media consumer then persists running and terminal refresh state, metadata, and image status even when all cached inputs remain reusable. At the current collection size, one unchanged run can therefore consume the Workers KV Free Plan daily write allowance.

This change is an isolated production stopgap. It preserves KV as the current storage system and keeps all public API contracts intact while the later D1/R2 changes are built.

## Architecture

### Daily orchestration

The Worker Cron creates one live Workflow at 20:00 UTC, corresponding to 04:00 Asia/Shanghai on the following local day. Manual live runs remain available for diagnosis. Shadow runs fetch and compare public data but never reserve media budget or enqueue media work.

Scheduled and manual live runs share one budget period keyed by UTC date. There is no force or bypass parameter. A run that cannot reserve media work still completes collection and calendar publication.

### Refresh planning before enqueue

After collections and calendar have been fetched and normalized, the Workflow deduplicates their subject IDs and processes them in bounded chunks. For each subject it reads the existing detail, metadata, image, and refresh records and derives component-level freshness without writing.

A subject becomes a candidate only when at least one required component is missing, its source identity has changed, its retry state is due, or its deterministic refresh time has elapsed. `nextSubjectRefreshAt` remains the single 6-to-8-day expiry rule so all callers use the same boundary semantics.

Each candidate carries only the components that require work and one priority class:

1. newly observed or source-changed;
2. hot and due;
3. cold and in the current `subject_id mod 7` shard;
4. due retry.

Ordering inside each class is deterministic so Workflow replay and a next-day rerun make the same selection. Ordinary candidates stop at the soft limit of 50. Necessary new or changed candidates may extend selection to the hard limit of 100. Remaining candidates are not persisted as a large queue; the next daily run derives them again from authoritative cache state.

### Shared daily budget

The stopgap budget extends the existing `SnapshotCoordinator` Durable Object with one compact authoritative UTC-day record and stable per-Workflow reservation markers. The coordinator derives the budget date from its own clock, atomically records the logical grant before queue submission, and binds that grant to deterministic job IDs. It must never grant more than 100 logical jobs across scheduled and manual live runs in one actual UTC day.

This Durable Object budget is deliberately temporary. The following D1 change replaces it with an atomic D1 reservation table. The stopgap therefore exposes a narrow `/reserve-media` interface rather than spreading budget state through orchestration code.

### Consumer compare-before-write

The media consumer distinguishes real state transitions from observation time. It normalizes proposed metadata, image status, and terminal refresh values and compares them with stored values before each PUT.

It writes when content, source URL/hash, error/retry state, tombstone state, or another public semantic field changes. It does not write merely because a new Workflow instance inspected an item, reused an existing image, or reached an unchanged successful result. Error and tombstone transitions remain durable, and partial component success remains independently recordable.

### Observability

Each run reports aggregate counters with explicit, closed semantics: total subjects; eligible due candidates and candidates by priority; planner-selected candidates; logical grants; budget-deferred candidates (`candidates - logical_grants`); confirmed and uncertain producer outcomes; and subjects skipped before reservation (`total_subjects - candidates`). `refresh_jobs` remains a compatibility alias for logical grants, never a claim about physical Queue delivery. The Workflow does not label any estimate as actual KV writes because asynchronous consumer PUTs are only observable in the consumer and Cloudflare metrics. Error runs preserve the latest counters reached before failure. Counters belong to the bounded run result/log stream and do not create per-subject metric keys.

## Failure Semantics

- A collection or calendar pagination failure prevents destructive absence conclusions and fails that fetch stage as it does today.
- A media-state read failure affects only candidate planning for that subject and is surfaced in aggregate errors; it cannot silently cause an unlimited full refresh.
- Budget exhaustion produces zero additional media messages but does not fail public collection/calendar publication.
- Queue submission has an unavoidable acknowledgement ambiguity: Cloudflare proves persistence when `sendBatch` resolves but does not prove zero side effects when it rejects. The selected Free Plan policy is fail-closed: a stable reservation makes at most one producer attempt; any throw or confirmation-write interruption remains `uncertain`, continues to occupy the day's logical capacity, is never resent, and does not block snapshot publication. The next daily run derives still-missing media from authoritative cache state.
- Physical Queue delivery remains at-least-once. Deterministic `job_id` plus `SubjectRefreshCoordinator` serialization/deduplication prevents a completed logical job from repeating business KV side effects; later consumer compare-before-write further protects partial/failure paths.
- Workflow replay must return the previously recorded step result and must not reserve or enqueue a second time.
- A consumer failure may update error/backoff state only when that state actually changes.

## TDD Strategy

Implementation begins with observable KV and Queue doubles. The first red test runs 659 unchanged, complete, unexpired subjects through the full planning path and asserts zero queue messages and zero subject refresh/metadata/image PUTs.

Focused tests then cover:

- missing components and exact expiry boundaries;
- deterministic 6-to-8-day spread and seven cold shards;
- priority ordering, soft limit 50, hard limit 100, and deferred work;
- a manual run after a scheduled run has exhausted the UTC-day budget;
- shadow runs performing no reservation and no media enqueue;
- Workflow replay without duplicate reservation or messages;
- unchanged metadata/image/refresh values producing no PUT;
- changed content, errors, retries, and tombstones still producing required writes;
- media budget exhaustion not blocking collection/calendar publication.

Each red test is followed by the minimum implementation required to make it green, then refactoring under the same assertions. Verification includes focused sync-worker, media-worker, storage, and shared-package tests; full typecheck, test, and build; verified Wrangler configuration/dry-run commands; and production metrics after deployment.

## Deployment and Rollback

CLI flags and Wrangler keys are verified from installed help, types, or official documentation before edits. Code and documentation are committed and pushed in atomic units. The final stopgap deployment changes the production Cron only after the bounded planner and consumer zero-write behavior are green.

Production acceptance requires one successful scheduled live Workflow and a 24-hour KV curve below 100 writes, with no unchanged-run subject spike. Rollback may restore the previous deployment SHA or schedule, but must not restore unconditional full-subject media planning.

## Spec Patch

The `sync-write-budget` delta spec now explicitly requires scheduled and manual live runs to share the UTC-day budget, forbids a hard-limit bypass, and requires shadow runs to enqueue no media work.
