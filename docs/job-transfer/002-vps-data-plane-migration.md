# Job Transfer 002 — VPS Data Plane Migration

> Status captured: 2026-09-02, Asia/Shanghai  
> Previous transfer: [`docs/job-transfer/001-vps-data-plane-migration.md`](001-vps-data-plane-migration.md)  
> Next transfer: create `docs/job-transfer/003-vps-data-plane-migration.md`; do not overwrite this file

## Bootstrap prompt

Give the next AI Coding Agent this instruction:

```text
Read `/Users/ian/Desktop/Projects/BangumiTV/.worktrees/vps-coordinator-projection/docs/job-transfer/002-vps-data-plane-migration.md` completely, then follow its "Agent execution instructions" from the current checkpoint. Treat repository files and fresh Git/GitHub state as authoritative when they differ from this snapshot. Do not skip the current unfinished task. Before writing code, report the recovered phase, task, branch, HEAD, blocker, and the next permitted action.
```

If the worktree has moved or no longer exists, locate the repository, then search for the latest numbered file under `docs/job-transfer/` and read it completely. The highest numeric prefix is the newest handoff. Never infer current state from an older handoff without comparing it to Git, OpenSpec, Comet, and GitHub.

## Agent execution instructions

You are taking over an active, governed software migration. This is not a greenfield task and not an invitation to redesign the system. Recover the exact checkpoint, continue sequentially, and preserve all workflow gates.

Default language for user-facing updates and handoff reports is Chinese. Code, identifiers, commit titles, and repository terminology should follow existing project conventions.

### 1. First actions: recover facts before writing

Repository facts override this handoff if they have changed. If they conflict, stop and explain the exact conflict instead of guessing. All state below was re-verified from Git/GitHub/Comet/OpenSpec on 2026-09-02 after the PR14 merge; treat later repository changes as authoritative.

- Repository: `/Users/ian/Desktop/Projects/BangumiTV`
- This handoff branch: `codex/vps-handoff-002` at merge base `6c522f09e1eaa5caa66f9c3576e27bcc20684d29` (== `origin/dev` post PR14). It exists only to carry this document. Create a fresh worktree/branch for the Task 3.1 batch from `origin/dev`.
- OpenSpec change: `migrate-data-plane-to-vps`

Before modifying anything:

1. Run `git status --short --branch`, `git rev-parse HEAD`, `git fetch origin`, and compare local with remote.
2. Read these files completely:
   - `AGENTS.md`
   - `docs/rules/docs-sync.md`
   - `.claude/rules/comet-phase-guard.md`
   - `.codex/skills/comet/SKILL.md`
   - `.codex/skills/comet-build/SKILL.md`
   - `.agents/skills/subagent-driven-development/SKILL.md`
   - `.agents/skills/test-driven-development/SKILL.md`
   - `.codex/skills/comet/reference/subagent-dispatch.md`
   - `openspec/changes/migrate-data-plane-to-vps/.comet.yaml`
   - `openspec/changes/migrate-data-plane-to-vps/.comet/subagent-progress.md`
   - `openspec/changes/migrate-data-plane-to-vps/proposal.md`
   - `openspec/changes/migrate-data-plane-to-vps/design.md`
   - `openspec/changes/migrate-data-plane-to-vps/tasks.md`
   - every delta spec under `openspec/changes/migrate-data-plane-to-vps/specs/`
   - `docs/superpowers/specs/2026-08-28-vps-data-plane-migration-design.md`
   - `docs/superpowers/plans/2026-08-28-vps-data-plane-migration.md`
   - `docs/runbook/vps-data-plane.md`
   - `docs/verification/2026-08-31-vps-sync-postgresql-18-integration.md`
   - Rules in handoff 001 §2, §6-§8 remain in force (architecture, mandatory repository rules, Comet/review/task/phase gates, GitHub PR and AI-review hard gates). Read `docs/job-transfer/001-vps-data-plane-migration.md` for those sections if not already loaded.
3. Run `pnpm exec openspec list --json` and inspect the active change state.
4. Recalculate the first unfinished OpenSpec task and the remaining task count. Do not trust the count in this snapshot after work has progressed.
5. Check the actual GitHub PR state before crossing any merge gate. A pushed branch or open PR is not a merge.
6. If the worktree is dirty, attribute every modified file before acting. Preserve user changes. Never reset, discard, or overwrite unexplained work.
7. Report the recovered phase, current task, branch, HEAD, dirty state, current blocker, and next permitted action to the user before writing code.

### 2. Current Comet and task state (verified 2026-09-02)

- `.comet.yaml`: workflow `full`, phase `build`, `build_mode: subagent-driven-development`, `tdd_mode: tdd`, `review_mode: thorough`, `isolation: worktree`, `auto_transition: true`, `verify_result: pending`, `verification_report: null`, `archived: false`. Do not advance phase or touch `verify_result` without a user-approved gate.
- OpenSpec `tasks.md` completed (4): 1.2, 2.1, 2.2, 2.3. Unchecked (17): 1.1 (partial — see below), 3.1, 3.2, 4.1, 4.2, 5.1, 5.2, 6.1, 6.2, 7.1, 7.2, 8.1, 8.2, 9.1, 9.2, 9.3, 9.4.
- Task 1.1 remains unchecked ONLY for its separately tracked `psql --help` and Docker/CI container checks; the Node `pg` migration/advisory-lock path is complete and verified on PostgreSQL 18.6 (2026-08-31 evidence). It is not a gate for Task 3.1.
- **Current unfinished task (next work): OpenSpec Task 3.1** — "Define PublicSnapshotManifestV1 and canonical snapshot hashing, key validation, generation allocation, and identical-content no-op tests". Plan heading: `Task 3.1: Manifest V1、canonical hash 与 generation 规则` (plan file ~line 150). Delta spec: `openspec/changes/migrate-data-plane-to-vps/specs/r2-snapshot-publication/`. Related later spec: `postgres-r2-backup`.

### 3. Merge evidence for the completed gate

- PR14 `Skyline-Gazer/AiringCal#14` (`fix(vps-sync): close Task 2.2 authority projection and fail-closed persistence validation`), base `dev` ← head `codex/vps-coordinator-projection`, **MERGED** `6c522f09e1eaa5caa66f9c3576e27bcc20684d29` (2026-09-02T08:47:55Z).
- Branch commits `adc0d1d..6c522f0`: `0237a22` feat projection, `63373be` harden projection, `9e19d78` partial rating presence, `da06a86` partial rating boundaries, `1537e38` subject name presence, `9b0886b` reject explicit undefined in validators (5th authorized round), `c75823d` test-only tags/expires_at guards, `32570c8` Task 2.2 checkoff, plus coordination/doc commits (`4e4c29c`, `468af74`, `363e4f2`, `b24f885`, `51735e8`).
- Earlier gates already merged into `dev`: PR11 (Task 2.1 upstream fetch), PR12 (retry boundary), PR13 (Task 2.2 coordinator, merge commit `c4b97093`), Task 2.3 implementation with design/delta/plan update.

### 4. Required implementation method for the current unfinished task

Continue under the same gates as Task 2.2: strict TDD (RED first with recorded failing output, then GREEN), atomic commit + immediate push per `docs/rules/docs-sync.md`, fresh implementer subagents for runtime code while `build_mode: subagent-driven-development` is active, independent thorough review before checkoff, Comet `task-checkoff` against the exact unique task text, and PR with a merge gate — the user merges; a merge is not a push or an open PR.

Authoritative scope and order for Task 3.1+: OpenSpec `tasks.md` (R2 publication tasks 3.1-3.2 next), the implementation plan `Task 3.1`/`Task 3.2` steps, and delta spec `r2-snapshot-publication`. The plan for Task 3.1 names these interfaces to produce: `PublicSnapshotManifestV1` exact fields; `buildManifest(snapshot, metadata)`; `parsePublicSnapshotManifestV1(value)`; `snapshotKey(generation, hash)`; `canonicalSnapshotBytes(snapshot)`; and to preserve `PublicSnapshotV1` response shape with `published_at` as Unix-second integer while `buildManifest` emits ISO `published_at` denoting the same instant; same business payload at different wall-clock times must keep the same `content_hash`. Files: modify `packages/domain/src/public-snapshot.ts` (+ `.test.ts`), `packages/domain/src/index.ts`; create `packages/domain/src/public-manifest.ts` (+ `.test.ts`). Verify every referenced export against current source before writing.

Note: sub-agent dispatch was observed to hit an external weekly usage limit on 2026-09-02 (`opencode` 429 GoUsageLimitError). If sub-agents are unavailable again, ask the user before deciding whether to proceed with a coordinator-directed/authorized direct change; do not silently violate `build_mode: subagent-driven-development`.

### 5. User-requested handoff protocol (applies to the next handoff too)

When the user requests a handoff: stop opening new tasks; if the current atomic change can be safely completed, verify/commit/push it (otherwise preserve the dirty worktree and document it exactly); create the next numbered file `docs/job-transfer/003-vps-data-plane-migration.md` incrementing the prefix, linking this file near the top, never overwriting an older handoff; include a new bootstrap prompt; commit and push as an atomic documentation commit when the workflow permits (explain storage and incorporation if a PR/merge gate blocks the active branch); return the structured handback report below.

## Required handback report (state as of this handoff)

```text
Status: DONE

Repository and workflow
- Repository: /Users/ian/Desktop/Projects/BangumiTV
- Worktree: /Users/ian/Desktop/Projects/BangumiTV/.worktrees/vps-coordinator-projection (handoff branch; create a fresh worktree for Task 3.1)
- Branch: codex/vps-handoff-002 (carries only this document, based on merged origin/dev)
- Base commit: 6c522f09e1eaa5caa66f9c3576e27bcc20684d29 (merged origin/dev after PR14)
- Local HEAD: 6c522f0 + handoff commit
- Remote HEAD: to be pushed (codex/vps-handoff-002)
- Dirty worktree: clean
- Comet workflow/phase: full / build (verify_result: pending, archived: false)
- Current OpenSpec task: 3.1 Define PublicSnapshotManifestV1 and canonical snapshot hashing, key validation, generation allocation, and identical-content no-op tests
- Current plan task: Task 3.1: Manifest V1、canonical hash 与 generation 规则

Work completed since previous handoff
- Commits and purpose: 5th authorized TDD fix round 9b0886b (reject explicit own-property undefined in persistence validators before any SQL); test-only completion c75823d (tags/expires_at explicit-undefined zero-SQL guards); coordination/doc commits 51735e8 (round record), 32570c8 (Task 2.2 checkoff); merged into dev by PR14 6c522f0
- Push status: all pushed to origin/codex/vps-coordinator-projection before merge; merged into origin/dev
- Files/modules changed (PR14): apps/vps-sync/src/upstream/projection.{ts,test.ts}, apps/vps-sync/src/postgres/persistence-validation.ts, apps/vps-sync/src/postgres/repositories.{ts,test.ts}, apps/vps-sync/src/{contracts.ts,run.ts,run.test.ts,upstream/fetch.test.ts}, packages/bgm-api/src/full-fetch-boundary.ts, packages/domain/src/{index.ts,calendar.test.ts}, apps/sync-worker/src/{d1-sync.test.ts,full-fetch-boundary.test.ts}, plus Design Doc/plan/delta spec/runbook/progress/handoff docs
- Documentation/spec/plan changes: plan Task 2.2 Steps 1-5 checked and projection-closure narrative updated; tasks.md 2.2 checked; subagent-progress.md updated
- Task/plan checkbox changes: Task 2.2 open → checked
- .comet.yaml changes through scripts: none (phase/build mode unchanged)

TDD and verification evidence
- RED commands and observed failures: focused repositories test failed 30 pass/1 fail before 9b0886b (explicit undefined accepted + zero-query assertion); prior rounds' RED recorded in subagent-progress.md (missing empty-user evidence, synthesized zero rating, localeCompare, name collapse)
- GREEN focused commands and results: repositories+projection+runtime+migrate 67/67 (9b0886b); repositories.test 33/33 (c75823d); focused tags/expires_at positive controls pass
- Broader tests/typecheck/build results: pnpm -F @airing-cal/vps-sync test 148/148 then 150/150 (test-skip-pattern=PostgreSQL); tsc --noEmit PASS; tsc -p tsconfig.build.json PASS; pnpm build + plain-Node emitted-import check PASS (EMITTED_UPSTREAM_IMPORT_OK); pnpm exec openspec validate migrate-data-plane-to-vps --strict exit 0; git diff --check clean
- OpenSpec/Comet/diff/documentation gates: Comet task-checkoff PASS for task 2.2; docs state the presence/fail-closed boundary exactly (Design Doc §52/§83, delta spec, runbook §59); no-docs reasons recorded in commit bodies
- Live or environment-dependent checks not run and reason: real PostgreSQL integration suite (no DATABASE_URL in this worktree; PostgreSQL-skipped ordinary suite only); real upstream/R2/Sentry calls; Task 1.1 psql/Docker/CI container checks (separately tracked)

Review and PR state
- Independent review result: final thorough review APPROVED 0 CRITICAL / 0 IMPORTANT / 0 MINOR; previous final re-review APPROVED after c75823d
- Review/fix round: 5 authorized rounds + test-only completion, all user-authorized
- Resolved findings: user-evidence/empty-user fabrication, calendar-first rating/name presence, UTF-16 canonical ordering, partial-rating preservation, legacy boundary defaults, explicit-undefined fail-closed, tags/expires_at test coverage
- Unresolved findings with severity: none (0/0/0)
- PR URL: https://github.com/Skyline-Gazer/AiringCal/pull/14
- PR base/head: dev / codex/vps-coordinator-projection
- PR Draft/Ready/Merged state: MERGED 6c522f0
- GitHub review-thread replies still required: none (kody thread on PR14 line 804 answered as false positive with evidence, reply 3912287314; kody bot may re-review after changes — verify before acting)

Current project state
- Completed OpenSpec tasks: 1.2, 2.1, 2.2, 2.3
- Partial tasks: 1.1 (Node pg/migration/advisory-lock done and verified on PG18.6; only psql/Docker/CI container checks pending, not a gate)
- First unfinished task: 3.1 (per OpenSpec order; do not start 3.2/4.x on the basis of this snapshot alone)
- Remaining top-level task count, freshly calculated: 17 unchecked OpenSpec tasks (1.1 partial + 3.1-3.2, 4.1-4.2, 5.1-5.2, 6.1-6.2, 7.1-7.2, 8.1-8.2, 9.1-9.4)
- Remaining Comet phases: Build remainder (3.1 onward) → Verify (§9.2 verification report gate) → Archive; verify_result currently pending

Exact continuation boundary
- Current blocker or next permitted action: none blocking. Next permitted action: start OpenSpec Task 3.1 from merged origin/dev in a fresh worktree/branch, following TDD + atomic push + independent review + PR merge gate. Report recovered state to the user before writing code.
- User decision/authorization required: user merges each batch PR; user authorizes any extra review/fix round beyond 2/2 and any coordinator-directed change when sub-agents are unavailable; user decides when verification/cutover gates open
- Commands/files the next agent should inspect first: git status/rev-parse/log origin/dev; openspec/changes/migrate-data-plane-to-vps/tasks.md; plan Task 3.1 section (~line 150); delta spec r2-snapshot-publication; packages/domain/src/public-snapshot.ts; runbook; the file list in §1 above
- Prohibited next actions until the gate is cleared: no phase advancement to Verify/Archive while verify_result is pending; no production cutover, deletion, or real external publication during Build; no starting 3.2 before 3.1's PR merge; no unverified API/CLI/config keys (Rule §零)

Next handoff file
- Path: docs/job-transfer/003-vps-data-plane-migration.md
- Previous handoff linked: yes (this file links 001; 003 will link 002)
```

## Current user decision needed

None. Task 2.2's PR14 is merged and verified; the checkpoint has no open blocker. The next workflow action is to start OpenSpec Task 3.1 from the merged `origin/dev` baseline after reporting the recovered state to the user.
