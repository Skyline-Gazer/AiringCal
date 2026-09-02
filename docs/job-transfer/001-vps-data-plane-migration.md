# Job Transfer 001 — VPS Data Plane Migration

> Status captured: 2026-09-02, Asia/Shanghai  
> Previous transfer: none  
> Next transfer: create `docs/job-transfer/002-vps-data-plane-migration.md`; do not overwrite this file

## Bootstrap prompt

Give the next AI Coding Agent this instruction:

```text
Read `/Users/ian/Desktop/Projects/BangumiTV/.worktrees/vps-coordinator-projection/docs/job-transfer/001-vps-data-plane-migration.md` completely, then follow its "Agent execution instructions" from the current checkpoint. Treat repository files and fresh Git/GitHub state as authoritative when they differ from this snapshot. Do not skip the current unfinished task. Before writing code, report the recovered phase, task, branch, HEAD, blocker, and the next permitted action.
```

If the worktree has moved or no longer exists, locate the repository, then search for the latest numbered file under `docs/job-transfer/` and read it completely. The highest numeric prefix is the newest handoff. Never infer current state from an older handoff without comparing it to Git, OpenSpec, Comet, and GitHub.

## Agent execution instructions

You are taking over an active, governed software migration. This is not a greenfield task and not an invitation to redesign the system. Recover the exact checkpoint, continue sequentially, and preserve all workflow gates.

Default language for user-facing updates and handoff reports is Chinese. Code, identifiers, commit titles, and repository terminology should follow existing project conventions.

### 1. First actions: recover facts before writing

Work in this repository and current isolated workspace:

- Repository: `/Users/ian/Desktop/Projects/BangumiTV`
- Active worktree: `/Users/ian/Desktop/Projects/BangumiTV/.worktrees/vps-coordinator-projection`
- Active branch: `codex/vps-coordinator-projection`
- Remote branch: `origin/codex/vps-coordinator-projection`
- Captured HEAD: `363e4f28e5725ca4f1e600d8cd72cd9d9c78b4df`
- Current base for this task batch: merged `origin/dev` at `adc0d1d`
- OpenSpec change: `migrate-data-plane-to-vps`

Before modifying anything:

1. Run `git status --short --branch`, `git rev-parse HEAD`, and compare the local branch with its remote.
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
3. Run `pnpm exec openspec list --json` and inspect the active change state.
4. Recalculate the first unfinished OpenSpec task and the remaining task count. Do not trust the count in this snapshot after work has progressed.
5. Check the actual GitHub PR state before crossing any merge gate. A pushed branch or open PR is not a merge.
6. If the worktree is dirty, attribute every modified file before acting. Preserve user changes. Never reset, discard, or overwrite unexplained work.
7. Report the recovered phase, current task, branch, HEAD, dirty state, current blocker, and next permitted action to the user before writing code.

Repository facts override this handoff if they have changed. If they conflict, stop and explain the exact conflict instead of guessing.

### 2. Project objective and architecture

The migration moves periodic data-plane work off Cloudflare plan-limited write infrastructure and onto a low-resource VPS while keeping public reads on Cloudflare:

```text
VPS host cron
  -> one-shot Docker Compose TypeScript sync container
  -> Bangumi API
  -> provider-neutral hosted PostgreSQL through DATABASE_URL
  -> immutable public snapshot and manifest in R2
  -> PostgreSQL backup in private R2 prefix
  -> Feishu terminal notification

User
  -> Cloudflare Frontend Worker
  -> Read Worker
  -> R2 manifest + immutable snapshot
  -> verified Cache API fallback
  -> migration-period legacy KV fallback
```

Established technical choices:

- Node.js + TypeScript; reuse existing `bgm-api`, domain, and snapshot contracts.
- PostgreSQL provider is replaceable and accessed only through standard `DATABASE_URL` with TLS. No provider SDK.
- PostgreSQL support and acceptance baseline is PostgreSQL 18 / maintained 18.x.
- PostgreSQL is not part of Docker Compose; hosted PostgreSQL is external.
- VPS uses host cron and `docker compose run --rm sync` for one-shot execution.
- Cloudflare does not call the VPS or PostgreSQL during normal public reads.
- R2 publication uses immutable snapshots plus an atomically replaced manifest.
- PostgreSQL backups use `pg_dump` and are uploaded to R2.
- Every terminal run state is reported through Feishu; optional Sentry tracing is fail-open and disabled without a DSN.
- Production and debug images are Alpine-based and delivered through GHCR with immutable full-Git-SHA tags.
- No automated SSH deployment from GitHub Actions in this change.
- Existing Cloudflare synchronization is frozen but retained through shadow validation, rollback observation, and separately approved cleanup.

Full architecture, schemas, state machines, publication protocol, backup rules, container constraints, and rollout rules are in the Design Doc and implementation plan listed above. Do not replace them with this abbreviated summary.

### 3. Current Comet and task state

At capture time:

- Comet workflow: `full`
- Phase: `build`
- Build mode: `subagent-driven-development`
- TDD mode: `tdd`
- Review mode: `thorough`
- Isolation: `worktree`
- `verify_result`: pending
- Change is not archived

The OpenSpec plan originally contains 20 top-level tasks. At capture time:

- Completed: 1.2, 2.1, 2.3
- Partially complete: 1.1; Node `pg` migration/session-lock and real PostgreSQL 18 validation are complete, while separate CLI/container preflight remains pending and should be closed naturally by later backup/container work rather than reimplementing the Node path.
- Active and unchecked: 2.2
- Later tasks start at 3.1 and continue through 9.4.
- After Build, the Comet Verify and Archive phases remain.

This count is a snapshot. Recompute it whenever taking over or handing off.

Sequential progress rule:

- Resume the current unfinished task and its precise blocker first.
- Do not jump over an unfinished task or an unmerged PR to work on a later task.
- Once the current task passes its required review, update its plan/OpenSpec checkbox through the prescribed Comet checkoff process, commit and push the checkoff, create the task PR, and wait for the user to merge it.
- After the user explicitly says it is merged or GitHub confirms the merge, update from the new `dev`, recover Comet state again, and continue the next unfinished task.
- Continue through as many tasks as user decisions, reviews, PR merge gates, and available working time permit. There is no artificial stop before Task 3.1 or any other later task.
- Never merge a PR yourself.

### 4. Current exact checkpoint: Task 2.2

Task 2.2 is:

> Implement the one-shot run coordinator, heartbeat/terminal outcomes, no-change behavior, media refresh lifecycle, and concurrent-run exclusion with RED-to-GREEN tests.

The coordinator, media lifecycle, concurrency, terminal outcomes, tracing, and most CompleteFullFetch-to-authority projection work are already implemented and reviewed. Do not reimplement them.

The user confirmed this subject projection business rule:

- When calendar and collection provide the same subject field, the calendar-provided field is authoritative.
- Collection fills only fields that calendar did not provide.
- Presence is determined by own-property presence, not truthiness.
- Explicit `0`, `false`, and empty string are observed values and must be preserved.
- Values missing from both sources remain missing in VPS authority JSON and canonical hashing.
- Legacy/public compatibility adapters may apply old-shape defaults only at their explicit compatibility boundary.

Important implementation commits already pushed on this branch:

- `0237a22` — initial CompleteFullFetch-to-authority projection and coordinator connection.
- `63373be` — explicit observed-user evidence, exact configured-user matching, per-field rating precedence, locale-independent UTF-16 canonical ordering.
- `9e19d78` — preserve partial rating presence through projection and PostgreSQL validation.
- `da06a86` — preserve rank-only/total-only rating subsets in the shared boundary and omit partial rating from legacy public/D1 shape without fabricating zeros.
- `1537e38` — preserve missing versus explicit-empty subject names in VPS authority/hash and apply old empty-name compatibility only in the legacy public planner.
- `4e4c29c`, `468af74`, `363e4f2` — durable Comet review-blocker checkpoints; these are coordination evidence, not runtime changes.

Closed review findings that must not regress:

- Complete-fetch results carry explicit evidence for every fully observed configured user, including a truly empty user.
- Observed and configured user identities must match exactly; missing, unknown, and duplicate identities fail closed.
- Empty users are never fabricated from configuration alone, preserving deletion safety.
- Calendar/collection subject merge is deterministic across multiple users.
- Rating `score`, `rank`, and `total` preserve arbitrary partial subsets; explicit zero is authoritative.
- Partial legacy rating is omitted as a whole; the legacy public shape never fabricates missing rating fields.
- Missing subject name and explicit empty subject name remain distinct in VPS authority/hash.
- Canonical object key ordering uses explicit UTF-16 code-unit ordering, not locale-sensitive collation.
- Canonicalization rejects `undefined` and non-finite numbers.
- Coordinator performs projection before the PostgreSQL authority commit.
- Task 3.1 publication behavior has not been smuggled into Task 2.2.

Current unresolved review finding:

- `apps/vps-sync/src/postgres/persistence-validation.ts` treats explicit own-property `undefined` as if the property were missing.
- Known examples include:
  - `payload.name = undefined`
  - `payload.rating = undefined`
  - `payload.rating.score/rank/total = undefined`
  - `payload.images = undefined`
  - nested optional image fields explicitly set to `undefined`
- Existing optional validators check `value !== undefined` instead of checking own-property presence and then validating the value.
- This can let an inexact authority DTO pass validation, after which JSON/PostgreSQL serialization silently removes the undefined value while the caller-supplied content hash remains unchanged.
- The required behavior is fail closed before any SQL query or mutation.
- Valid missing properties, explicit `name: ''`, explicit numeric `0`, valid partial rating, and valid partial images must continue to pass.

The final review that found this issue reported 0 CRITICAL and 1 IMPORTANT. Task 2.2 remains unchecked.

The configured automatic review/fix allowance has already been exceeded through explicitly authorized rounds 3 and 4. The user has not yet explicitly authorized a fifth repair round at the time this file was captured. Receiving this handoff or being asked to read it is not itself authorization. Before implementing the unresolved validator fix, ask the user for explicit authorization unless a later user message clearly grants it.

### 5. Required implementation method for the current blocker

After explicit authorization:

1. Use a fresh implementer/fix agent for the repair. The main coordinator should not directly write runtime code while `build_mode` remains `subagent-driven-development`.
2. The fix agent must read the rule and TDD skills listed above.
3. Follow strict TDD:
   - Add tests for every explicit-own-`undefined` case.
   - Run the focused test and observe the expected RED failure.
   - Implement the smallest fail-closed validator change.
   - Run GREEN focused and regression suites.
4. Optional validation must follow this model:
   - If an optional key is absent, accept absence.
   - If `Object.hasOwn(record, key)` is true, validate the actual value; explicit `undefined` is invalid.
   - Apply the same rule to optional top-level nested objects and their optional nested fields.
5. Assert invalid inputs cause zero SQL queries or mutations.
6. Keep valid missing values, explicit empty string, explicit zero, partial rating, and partial images working.
7. Do not weaken secret/inexact-shape validation or canonical undefined rejection.
8. Synchronize Design Doc, delta spec, plan, and runbook only if the behavior statement changes or currently omits the strict boundary. If the existing documents already state it exactly, record a concrete no-docs reason in the commit body.
9. Commit one atomic fix and push immediately.
10. Use a fresh independent thorough reviewer. It must inspect the full `adc0d1d..HEAD` task diff, not only the last commit, and verify all previously closed findings plus the new validator fix.
11. Only 0 CRITICAL and 0 IMPORTANT permits Task 2.2 checkoff. A new CRITICAL/IMPORTANT after the authorized round returns to the user decision gate; do not silently extend repair scope or rounds.

Minimum validation for the current repair should include fresh evidence for:

- Persistence validator and repository focused tests.
- Projection, fetch, run, and PostgreSQL runtime fake tests.
- Full VPS unit suite.
- VPS typecheck, build:check, and build.
- Relevant bgm-api, domain, and sync-worker suites if shared DTO behavior is touched.
- Repository-wide test, typecheck, and build:check as appropriate.
- `pnpm exec openspec validate migrate-data-plane-to-vps --strict`.
- `git diff --check`.

There is no `DATABASE_URL` configured in the captured worktree. Do not claim real PostgreSQL integration has run unless it is freshly executed and evidenced. The historical PostgreSQL 18.6 evidence remains valid for its recorded commit and scenarios but is not proof for new validator code. Do not request, reproduce, log, commit, or place any database connection string or other credential in this handoff.

In the managed sandbox, `tsx` may fail to create its IPC socket with `EPERM`. If this occurs, treat it as an environment restriction, not a product failure. Use the platform approval mechanism for the established test command or a verified equivalent `node --import tsx --test` invocation. Do not silently change the test contract.

### 6. Mandatory repository rules

#### Verify before writing

Before writing or changing any CLI flag, configuration key, third-party API call, GitHub Actions input, Docker/Compose key, R2 call, Feishu field, or library method, verify it through `--help`, local types, source, existing verified repository usage, or official documentation. Never guess.

Before modifying any bgm.tv API interaction, inspect `docs/example/api/bgm-api.json` and verify endpoint, method, parameters, authentication, and response schema.

#### TDD and debugging

- New behavior and fixes require RED -> observed failure -> minimal GREEN -> refactor.
- Record exact RED and GREEN commands and concise results.
- If a test, build, or runtime behavior fails unexpectedly, use the repository's systematic-debugging workflow before proposing a source fix.
- Do not invent test helpers such as `freezeTime`, `unfreezeTime`, or `setRandomSeed` when the repository does not provide them.

#### Atomic commits and pushes

- Every atomic code, test, documentation, or coordination change must be committed and pushed immediately.
- Use Conventional Commit titles.
- Never make a title-only commit.
- Every commit body must contain these exact context sections:
  - `Business context`
  - `Expected behavior`
  - `Acceptance criteria`
  - `Constraints and edge cases`
  - `Verification`
- Record commands actually run, pass/fail counts where available, and explicitly identify tests or live checks not run.
- Use `no-tests: <specific reason>` only when tests genuinely do not apply.
- Never overstate an unexecuted gate as passed.

#### Documentation synchronization

- Code and its covered Design Doc, delta spec, plan, runbook, README, deployment, or verification documentation must stay synchronized.
- Do not document speculative or unimplemented behavior as current.
- Do not mark plan or OpenSpec tasks complete while required verification is still pending.
- Do not rewrite historical verification evidence to imply it covered later commits.

#### Secrets and external effects

- Never write database URLs, tokens, webhook URLs/secrets, R2 credentials, Bangumi credentials, request bodies, or raw exceptions containing secrets into code, docs, tests, commits, PRs, logs, or handoff files.
- Do not use credentials found in chat history or shell history.
- Production calls, cutover, scheduler changes, Cloudflare resource deletion, live R2 manifest changes, real Feishu delivery, or other external mutations require explicit task scope and user authorization.
- Preserve existing user work and avoid destructive Git commands.

### 7. Comet, review, task, and phase gates

- The active phase is Build. Re-read `.comet.yaml` before every operation that could cross a phase boundary.
- Do not hand-edit `.comet.yaml` to change phases. Use Comet state/guard scripts.
- Maintain `openspec/changes/migrate-data-plane-to-vps/.comet/subagent-progress.md` after dispatch, agent result, review, repair round, checkoff, and blocker changes.
- Main coordinator modifications are limited to plan/task/progress coordination under subagent-driven mode; use fresh implementer, fix, and reviewer agents for runtime work.
- Implementers and fixers do not check off plan/OpenSpec tasks.
- With thorough review, a task or risk batch needs independent review. CRITICAL and IMPORTANT findings must be fixed or returned to an explicit user decision gate.
- Only after review approval may the coordinator:
  1. update the unique plan task checkbox;
  2. update the mapped OpenSpec task checkbox;
  3. commit and push the checkoff;
  4. run Comet `task-checkoff` against the exact unique task text.
- Do not advance Build to Verify until all Build tasks are complete and the Build guard passes.
- Do not begin Archive without Verify passing and the required user confirmation.

### 8. GitHub PR and AI-review hard gates

Every task or explicitly defined risk batch is delivered through its own PR according to the current project workflow. A PR being created, Ready, Approved, or having green checks is not permission to continue the next task. The user must merge it, or GitHub must confirm it is merged.

The agent must never merge the PR itself.

Before creating or updating a PR:

- Verify the base branch is the repository's current integration branch, historically `dev`.
- Ensure the branch is pushed and the local/remote HEADs match.
- Ensure the working tree is clean except for explicitly documented coordination state that will be committed before PR creation.
- Make the PR Ready for review when development is complete. Keep Draft only while real development remains, and explain why.
- Include the OpenSpec change/task and links or repository paths to Design Doc, plan, delta spec, and verification evidence.

The PR body, linked GitHub task/Issue, OpenSpec task context, and relevant commit bodies must provide enough information for an AI reviewer to evaluate business logic. A title alone is never enough.

Required PR/task context:

- Business context: why the change exists and which business problem it solves.
- Business rules: authoritative precedence, data semantics, failure rules, and invariants.
- Expected behavior after the change.
- Acceptance criteria that can be tested.
- Constraints and edge cases, including compatibility and explicit non-goals.
- Verification: exact RED/GREEN and broader commands actually run.
- Unexecuted checks and why they were not run.
- Risk, rollback, and external-effect boundary.
- Files/modules changed.
- Independent review result and remaining accepted findings, if any.

If a PR links a GitHub Issue or another task whose description is only a title or otherwise lacks context, enrich that task when authorized. If external task editing is unavailable, put the complete context in the PR body and point to the exact OpenSpec task, Design Doc, plan, and delta spec. Do not leave the reviewer with a title-only linked task.

For AI review comments:

- Verify every finding against actual code, tests, types, and intended behavior before editing.
- Valid findings require a regression test and TDD repair.
- False positives require concrete evidence and a reply in the exact GitHub review thread.
- Do not add nonexistent APIs, duplicate tests, or incorrect behavior merely to silence a bot.
- Re-run relevant checks after review fixes and update the PR context.

After PR creation:

- Provide the PR URL, base/head branches, current Draft/Ready status, commits, verification summary, and known unexecuted gates.
- Stop at the merge gate.
- Resume only after the user explicitly reports merge or GitHub confirms it.

The repository remote has previously emitted a notice that the repository moved to `git@github.com:Skyline-Gazer/AiringCal.git`. Do not casually rewrite remotes. Verify the current remote and only change it when necessary and authorized.

### 9. Continuing beyond Task 2.2

After Task 2.2's PR is merged:

1. Fetch/pull the current integration branch without destructive reset.
2. Recover Comet state and recalculate the first unfinished task.
3. Create or reuse isolation according to the selected worktree workflow and current repository facts.
4. Read the full task text, design, delta spec, and plan steps for that task.
5. Verify every external API/CLI/config contract before writing.
6. Execute TDD, atomic commit/push, required review, task checkoff, PR, and merge gate.
7. Repeat sequentially for as many tasks as the user and workflow allow.

Expected later Build work includes immutable R2 publication, Read Worker cutover and fallback, backup/restore, Feishu notification delivery, Alpine production/debug images, Compose/cron operations, GHCR workflows, documentation, full verification, migration operations, and cleanup gates. These descriptions are navigation only. The authoritative scope and order are the current OpenSpec tasks and implementation plan.

Do not start a later task based solely on this list. Always select the first unfinished task after the preceding PR merge.

### 10. User-requested handoff protocol

The user controls when another handoff is needed. The agent cannot reliably read remaining usage quota and must not claim it can.

When the user requests handoff:

1. Stop opening new tasks or broadening scope.
2. If the current atomic change can be safely completed, verify it, commit it, and push it.
3. If it cannot be safely completed, do not create a misleading commit and do not discard changes. Preserve the dirty worktree and document every changed file, partial behavior, failed/pending command, and exact recovery action.
4. Create the next immutable numbered file under `docs/job-transfer/`:
   - increment the three-digit prefix (`002`, `003`, ...);
   - keep a concise stable job name, normally `vps-data-plane-migration`;
   - link the previous handoff path near the top;
   - never overwrite or rewrite an older handoff;
   - treat the newest file as a state snapshot, not a replacement for Git/OpenSpec/Comet verification.
5. Include a new bootstrap prompt that tells the next agent to read the newest file completely.
6. Commit and push the handoff document as an atomic documentation commit when the current workflow permits. If a PR/merge gate prevents committing it on the active branch, explain where it was stored and how it must be incorporated.
7. Return the structured handback report below to the user.

Required handback report:

```text
Status: DONE | BLOCKED | NEEDS_CONTEXT

Repository and workflow
- Repository:
- Worktree:
- Branch:
- Base commit:
- Local HEAD:
- Remote HEAD:
- Dirty worktree: clean | list exact files
- Comet workflow/phase:
- Current OpenSpec task:
- Current plan task:

Work completed since previous handoff
- Commits and purpose:
- Push status:
- Files/modules changed:
- Documentation/spec/plan changes:
- Task/plan checkbox changes:
- .comet.yaml changes through scripts:

TDD and verification evidence
- RED commands and observed failures:
- GREEN focused commands and results:
- Broader tests/typecheck/build results:
- OpenSpec/Comet/diff/documentation gates:
- Live or environment-dependent checks not run and reason:

Review and PR state
- Independent review result:
- Review/fix round:
- Resolved findings:
- Unresolved findings with severity:
- PR URL:
- PR base/head:
- PR Draft/Ready/Merged state:
- GitHub review-thread replies still required:

Current project state
- Completed OpenSpec tasks:
- Partial tasks:
- First unfinished task:
- Remaining top-level task count, freshly calculated:
- Remaining Comet phases:

Exact continuation boundary
- Current blocker or next permitted action:
- User decision/authorization required:
- Commands/files the next agent should inspect first:
- Prohibited next actions until the gate is cleared:

Next handoff file
- Path:
- Previous handoff linked: yes/no
```

The handback must distinguish facts verified from Git/GitHub from claims copied from earlier reports. Never claim an unrun test, live service check, merge, or phase transition.

## Current user decision needed

At this captured checkpoint, the next permitted workflow action is to ask the user whether they explicitly authorize a fifth TDD repair round for the authority optional-field `undefined` validator finding. Do not infer that authorization from the existence of this file.

If authorized, continue from Section 5. If not authorized, leave Task 2.2 unchecked and report the accepted or unresolved deviation without advancing.
