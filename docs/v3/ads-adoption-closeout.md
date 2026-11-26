# ADS v0.8.0 adoption — observation closeout (T0/T1/T2)

> Evidence record for Owner directive 2026-11-25 (issue #183 phase P5) and upstream
> research issue [Skyline-Gazer/ads#133](https://github.com/Skyline-Gazer/ads/issues/133).
> Lite profile is the adopted default (`.ads/docs/lite-adoption.md`); project AGENTS.md
> rules (verify-before-writing §零, docs-sync, Comet guard, project-only filesystem
> boundary) remain authoritative where stricter. All facts are command-verifiable on
> `origin/dev`.

## T0 — baseline before adoption (2026-11-25, pre-#184)

| Fact | Value |
| --- | --- |
| `dev` HEAD | `0ec26a0a` (ship-readiness verdict PR #182) |
| `.ads` gitlink (AGENTS.md + index) | `82c3404b68995425249a022bdbeb4ac18b88fcd0` |
| Submodule working state | **not initialized** (`git submodule status` had no checkout) |
| ADS version relationship | `82c3404b` is a strict ancestor of `v0.8.0` (`git merge-base --is-ancestor` → true; pure fast-forward) |
| Governance in force | project AGENTS.md only; no profile declared |

## T1 — adoption activation (PR #184 → `dev a7a9bb96`)

| Fact | Value |
| --- | --- |
| Approved target | `v0.8.0^{commit}` = `178212c41cce8fbf9354d4066e0f77341f6f23c4` (tag verified this session) |
| Change | `.ads` gitlink advance + AGENTS.md pin line; isolated PR, `Refs #183` (tracking issue stays open) |
| CI on #184 | full pipeline green incl. `v3 operator smoke` |
| Activation proof (this host) | `git submodule status .ads` → ` 178212c4… (v0.8.0)`, tree clean; STANDARD/SAFETY/QUALITY/agent-adoption/lite-adoption/git-governance read **in-session** after init; adoption receipt posted on #183 |
| Cross-host activation | **NOT_VERIFIED** (no other consumer host ran this round) |

## T2 — observation window (same day; four merged PRs after adoption)

| PR | Scope | Post-adoption behavior observed |
| --- | --- | --- |
| #185 `9480cb7a` | private-R2 worker-origin public object interface, Worker CORS, deploy origin modes, probe lifecycle | §零 verify-before-writing: plan/runner/CLI surfaces re-derived from source before docs; no raw bucket exposure; staging FROZEN untouched; no live mutations |
| #186 `13a6996b` | step-level environment-scoped writer gates (#73), docs `--env` truth, stale `package-lock.json` removal | doc claims corrected against `--help`/source output; contract tests updated deliberately, not re-pinned |
| #187 `b0a54410` | verifier positive private-object proof + honest verify CLI docs | fail-closed by default; explicit `--allow-unproven-isolation` instead of silent skips |
| (branch hygiene) | `ads/v0.8.0-adoption`, `v3-private-r2-convergence`, `v3-release-gates`, `v3-verifier-private-proof` deleted after merge; remote set = `dev`, `main`, `archive/main-before-v3-alignment-20261016` | task-scoped branch lifecycle; inventory taken before prune |

No drift incidents: the `.ads` gitlink moved only in #184; no session auto-updated or
read outside the repo boundary (§零 project-only rule kept ADS reads inside
`AiringCal/.ads`); lite profile meant no strict-lifecycle receipts beyond the
Owner-mandated evidence in this file.

## Handoffs posted to ads#133

1. **Adoption timeline handoff** — the T0/T1/T2 table facts above, with verifiable
   SHAs and commands (`git merge-base --is-ancestor 82c3404b 178212c4`,
   `git submodule status .ads`).
2. **Capability audit handoff** — what v0.8.0 guidance actually covered in a full
   real round (lite default fitting an existing strict AGENTS.md; target-content-as-data
   hygiene; isolated gitlink PR pattern) and the gaps: cross-host activation evidence
   undefined in `lite-adoption.md`; provider quirk worth recording in
   `git-provider.md` — GitHub job-level `if` resolves only repository-level `vars`,
   which silently broke the environment-scoped production dispatch gate (fixed
   consumer-side in #186).

Both comments reference this file as the in-repo evidence anchor.

## Incremental Consumer Evidence — 2026-11-26 (#208 Production Clean Init Recovery II)

During the second actual interactive Production Clean Init on `c6fd64ff`, two consumer-side engineering gaps surfaced after `#205` (no ADS pin change; `.ads` remains pinned at `v0.8.0` / `178212c4`):

1. **Test Double Fidelity (confirmed trigger)** — `scripts/fixtures/wizard-acceptance-hooks.mjs` stubbed `ensureBucket()` as an unconditional success while the real Live I/O Adapter (`scripts/deploy-env-live-io.mjs`) required S3 credentials inside `ensureBucket()`. Real PTY acceptance therefore passed on a precondition that failed in live execution. Remedied with a stateful controlled-provider simulator (`scripts/fixtures/controlled-provider-sim.mjs`) exercising the real `runProductionApply`, `createLiveDevelopmentApplyIo`, credential state, and mutation ledger at the lowest transport/CLI boundaries (`scripts/live-adapter-integration.test.mjs`), keeping fixture-level PTY coverage labeled separately from real-adapter integration coverage.
2. **Partial External Mutation Accounting (confirmed trigger)** — Composite operations that mutate external state before failing (e.g., creating R2 bucket `airingcal-production` before failing S3 credential checks) left `mutationsExecuted: []` when accounting recorded only enclosing step completion. Remedied with a point-of-execution mutation ledger (`scripts/mutation-ledger.mjs`) distinguishing intended, attempted, confirmed-success, confirmed-failed, unknown-outcome, already-exists, compensation-success, and compensation-failed outcomes, with 7 targeted failure-injection scenarios covering bucket creation, token creation/scope/cleanup, GitHub Environment sync, Worker deployment, isolation probe write/HEAD/cleanup, and ambiguous lost-response transport errors.
