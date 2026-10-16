# AiringCal v3 — Cursor Agent Handoff

Date: 2026-10-16. Source of truth: GitHub (refresh live refs/CI before acting).

## Immediate instruction

You are taking over the `Skyline-Gazer/AiringCal` v3 engineering work from ChatGPT. **Start by reading this document and linked docs, then inspect actual code. Do not restart product discovery.** The user requested continuous implementation with autonomous, reviewable PRs and GitHub Project as source of truth. No additional A/B/C choices unless a genuinely blocking product decision arises.

## Remote state at handoff

- Repository: https://github.com/Skyline-Gazer/AiringCal
- Integration branch: `dev` = `a4b3b082d15943e11a2d5443077f9ab5f3c175dc`.
- `main` aligned to identical commit (historical main saved in `archive/main-before-v3-alignment-20261016`).
- Working bootstrap branch: `feat/v3.0.0` = `1e2a119a5212e73eb4848c75081e17af7dffa66a` at handoff.
- Version on bootstrap branch: `3.0.0-alpha.0` in root package.json.
- Draft PR: https://github.com/Skyline-Gazer/AiringCal/pull/68, `feat/v3.0.0 -> dev`. **Do not merge without evidence and review.**
- Project of record: https://github.com/orgs/Skyline-Gazer/projects/7. Historical #5/#6 designated for closure, but **not confirmed closed**; Project #7 membership/status not confirmed due to previous connector constraints.
- Parent Issue: https://github.com/Skyline-Gazer/AiringCal/issues/67
- Issue #69 P0 audit / CF–EdgeOne matrix; #70 P1 Builder/SQLite; #71 P2 Release/images/frontend; #72 P3 CF/EdgeOne; #73 P4 migration/rollback/cutover; #74 Alibaba OCR governance.
- CI latest observed at handoff: https://github.com/Skyline-Gazer/AiringCal/actions/runs/38870336521 success; OCR https://github.com/Skyline-Gazer/AiringCal/actions/runs/38870336485 **in progress**, previous OCR run cancelled due to newer push. Check jobs/steps/results, not merely workflow success.

## Read these files in order

1. `AGENTS.md`, `START_HERE_FOR_AI.md`, `docs/README.md` — current operational truth; historical VPS docs are archived.
2. `docs/v3/implementation-baseline.md` — confirmed architecture, priorities and gates.
3. `docs/v3/p0-contract-audit.md` — preliminary source verified audit and unverified capability matrix.
4. `apps/web-worker/src/index.ts`, `apps/web-worker/src/read-api.ts`, `apps/web-worker/src/r2-snapshot.ts`, `docs/reference/web-worker-public-api.md`.
5. `apps/node-jobs/src/sync/pipeline.ts`, `packages/domain/`, `packages/bgm-api/`, `packages/storage/`.
6. `.github/workflows/ci.yml`, `.github/workflows/ocr-review.yml`, `apps/node-jobs/docs/operator-contract.md`.
7. Reference architecture: https://github.com/xixu-me/Xget, especially `src/app/handle-request.js`, `adapters/`, `src/upstream/cache-policy.js`. Reuse *thin-platform-adapter design*, not the runtime itself.

## Non-negotiable product decisions

- Personal Bangumi calendar, **one user / one instance**, no multi-user, multi-tenant, authentication UI or unnecessary features.
- Preserve current v2 frontend look and behavior. Prioritize CF and Tencent EdgeOne in initial major release; introduce others in later small versions. Docker/Compose is also a core portable deployment target; test its full path in planned phases.
- Portable Core, thin adapters, no Cloudflare-specific logic in domain. Offline Builder handles Bangumi sync, SQLite, original and default 320x427 WebP q78 thumbnail. Cloud image transforms/CDN optional enhancements.
- Daily incremental + full reconciliation every 7 days, configurable and manually runnable. Critical collection/calendar incomplete -> no new release. Noncritical detail/image failures may reuse verified prior data and must be disclosed in result.
- Docker web/scheduler/builder separation. SQLite persistent local canonical state, WAL only on local filesystem, bounded job queue/leases and retries; external Builder with private checkpoints for serverless.
- Separate Public Store immutable Releases from Private Store checkpoints. Version-pinned reader, pointer commit last after verification, fail closed unless exclusive publisher safety proven. Backup/import/rollback; ≥30 days AND ≥5 successes retention + pins + reference-aware GC.
- Standard `airingcal.yaml`, env Secrets, `airingcal setup` CLI. One-off verified v2 D1/R2/KV import, explicit cutover. No production deployment, deletion, or resource spending without owner approval.
- Public JSON splitting: choose from **measured** v2 real data and frontend request flow, not another decision round.

## OCR configuration (owner says already set)

- Alibaba OpenCodeReview `1.13.0`, official Action pinned to commit `1672852136fc87748249d22bce0819f33419ea79`.
- Current source: `.github/workflows/ocr-review.yml` on bootstrap branch.
- Organization Variable `OCR_LLM_URL`, Organization Secret `OCR_LLM_AUTH_TOKEN`, Variable `OCR_LLM_MODEL` (owner configured). Workflow must read `vars.OCR_LLM_URL` and `secrets.OCR_LLM_AUTH_TOKEN`, `vars.OCR_LLM_MODEL`.
- OpenAI-compatible, incremental/sticky, advisory, same-repo PR only, no credentials on forks; do not expose token or log its contents.
- **Verify** a real OCR review step ran. A green run with review skipped does not count. Do not silently switch models. Treat API failure/timeouts as failure, not clean review.

## Next autonomous tasks

1. Refresh `git fetch` / PR #68 / all check runs / Project #7. Preserve uncommitted work if any. Check whether OCR actually reviewed and diagnose via logs if not. Check CI deploy jobs: no v3 feature branch production deploy.
2. Complete #69 as a measured, code-backed contract/capabilities analysis (route+payload fixtures, frontend network reads, Cloudflare/EdgeOne adapter constraints, explicit unknowns). Update Issue #69 with evidence; do not mark fully done solely due to preliminary doc.
3. Add platform-neutral interfaces and contract tests in a **small scoped PR** targeting `dev` (avoid overlapping draft #68; coordinate plan for bootstrap merge first or create separate branch from `dev` and reconcile). Start #70 portable Builder only after interface tests.
4. Configure Project #7 items/status if Cursor environment has GitHub project write access; otherwise record blocker; don't claim changed.
5. For each task: branch, minimal diff, tests, CI, OCR review, PR, issue/project state; repeat until phase done. Stop on unsafe production action or unsupported platform coordination, not on routine decisions.

## Important known concerns

- Current `dev` production read is `apps/web-worker` and QingLong writes `apps/node-jobs`, with Cloudflare D1, KV pointer, R2 images/snapshots. Archived VPS designs are **not** production truth.
- Existing `apps/web-worker/src/index.ts` exposes `GET /api/collections`, `/api/calendar`, `/api/config`, `/api/health`, `/api/version`, `/api/cache`, and image routes. Authenticated `POST /api/thumb-gen` does CF image processing; must move into Builder.
- v2 already has canonical snapshots, manifest validation and immutable R2 object versions. Leverage existing code.
- Avoid oversized generic middleware, multiple frontend rewrites, Xget's generated distribution branch workflow pattern, universal lock services, or a cloud-pricing/deployment wizard in v3 first milestone.
- No code changes are automatically deployed to production by merely writing docs on `feat/v3.0.0`. However CI configuration has deployment jobs for non-PR `dev` pushes/manual dispatch; inspect before merging or triggering.
- UI/spec decisions are largely settled; user's direction is to **ship, not interview**.

## Owner reporting format

Concise factual summary after each unit: issue, branch/PR, HEAD SHA, test and CI evidence, OCR actual status, blocked/next. Do not declare CI/OCR success before checking. Never automatically merge production/cutover PR.
