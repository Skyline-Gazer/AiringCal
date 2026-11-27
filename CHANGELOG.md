# Changelog

All notable changes to **AiringCal** are documented in this file.

---

## [Unreleased]

### Toolchain & Self-Service Update Flow

- **Toolchain pins**: `packageManager` and every GitHub Actions pnpm pin now `pnpm@12.23.0`; root `engines.node` declares `>=24` (required by `node:sqlite`). `pnpm install` regenerates the lockfile under pnpm 12; build allowlists stay in `pnpm-workspace.yaml` (`allowBuilds`), which pnpm 12 still honors.
- **Explicit menu actions**: the setup menu splits **Install**, **Update** and **Recover**. An explicit choice is checked against the detected installation state and refused with `WIZARD_OPERATION_MISMATCH` (plus a fix-it suggestion) instead of silently re-provisioning; `--operation install|update|recover` runs one action directly.
- **Commit-aware Update** (`scripts/update-plan.mjs`): before credentials or any remote mutation, Update observes the workspace `HEAD`/tag, the latest published stable release on the release-source repository (a fork deploys its parent's releases), the Writer `RELEASE_REF` and the live Reader `/api/version`, and compares commit SHAs rather than version strings. It then `upgrade`s a clean workspace (tag resolved to a commit, target commit's `package.json` checked for `engines.node` — blocking on `UPDATE_NODE_TOO_OLD` — and `packageManager` — warning with the exact `corepack prepare` command — tag conflicts refused as `UPDATE_TAG_CONFLICT`, verified switch, `pnpm install --frozen-lockfile`, wizard re-exec with `--operation update`), `redeploy`s an at-target or Development workspace, stays `current` only when workspace, Writer ref and Reader version all match, `verify`s when `RELEASE_REF` is unset or the Reader is unreachable/different, and `blocked`s a dirty tree, unreadable git status, untagged divergence, local-ahead `HEAD`, unreadable release source, or an old Node. `current`/`verify` return the `NO_CHANGE` verdict; rollback is the printed `git switch --detach <previous HEAD>` plus `pnpm install --frozen-lockfile`.
- **Release-age policy**: `pnpm-workspace.yaml` keeps `minimumReleaseAge: 0` with the observed reason: pnpm 12 verifies lockfile entry ages even under `--frozen-lockfile` and fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` for any dependency published within its 1440-minute default (reproduced with `rolldown@1.3.4`). A release must install immediately after its dependencies publish; the trade-off is recorded inline.
- **Smoke process lifecycle**: `apps/v3-read-worker/scripts/staging-smoke.ts` spawns `node_modules/.bin/wrangler` directly instead of `pnpm exec wrangler`, runs `wrangler dev` in its own process group, kills the group on teardown and destroys the inherited pipes, so the supervised `workerd` cannot keep CI open after the checks pass.
- **Docs**: bilingual README/DEPLOYMENT now document the split menu, the observed preflight facts, commit-based equality, the upgrade/toolchain/tag-conflict path, `verify`/`NO_CHANGE`, the Development redeploy, and the rollback command.

### Frontend Modernization (`#221`, `#218`, `#219`, `#220`)

- **Framework frontend**: replaced the hand-written DOM/HTML widget (`packages/widget/assets/theme/*`) with a Preact + TypeScript app built by Vite. Assets stay at `/src/bangumi.js` and `/src/bangumi.css`, are bundled into the Reader Worker (single deploy unit), and preserve the Embeddable Widget contract (`.bgm-container`, `window.bgmConfig`, `public, max-age=300`).
- **Responsive pagination**: page capacity is measured from the rendered grid (`columns × 2 rows`), re-paginated on resize while keeping the first visible item, with previous/next controls. All non-final pages fill complete rows.
- **NSFW filtering before pagination**: `GET /api/collections` gained optional `nsfw=hide|show` (default unchanged); totals, page size and rows now agree, and the filtered representation carries its own `ETag`.
- **Calendar tab navigation**: one day panel, today selected by default, selection persists across re-renders and in the URL, no anchor scroll or auto-scroll, `tablist`/`tab`/`tabpanel` with arrow/Home/End keys.
- **Header/footer consolidation**: header status bar removed; footer shares the page width and reports `Build <sha> · <build time> | SUBJECTS <n> | LAST UPDATED <release publish time>` with explicit UTC. `Next Writer`/`Last Writer` and `/src/cache.js` removed.
- **Accessibility**: active-control contrast fixed (ink on accent), 3:1 focus ring, heading hierarchy, labelled tab panels, `aria-busy`/`aria-live` states, 44 px tap targets.
- **Tests**: removed source-text regex "behaviour" assertions; added pure-function tests plus Playwright acceptance across Chromium, Firefox and WebKit in a single CI job. API docs corrected (`q`, `sort`, `user_id` were never implemented).

### Post-Release Hardening & Engineering Convergence (`dev` Integration Branch)

- **Production Writer Release Execution Integrity & Explicit Release Authorization (`Fix A` / `Fix A1` / `Fix A2`)**:
  - `.github/workflows/portable-writer.yml` (`production` job) requires `AIRINGCAL_PRODUCTION_RELEASE_SHA` (exact 40-character hexadecimal git commit SHA) and optional `AIRINGCAL_PRODUCTION_RELEASE_REF` (e.g. `v3.0.0`), refusing mutable development branch references (`dev`, `refs/heads/dev`, `HEAD`) before checkout.
  - Checks out the approved release ref/SHA (`fetch-depth: 0`), verifies via `git rev-parse HEAD` that the checked-out executable source tree strictly matches `AIRINGCAL_PRODUCTION_RELEASE_SHA` before running `pnpm install`, building the Writer bundle, or publishing to R2, and passes the verified checked-out source SHA (`steps.verify_source.outputs.verified_source_sha`) as `BANGUMI_GIT_COMMIT_SHA` instead of the mutable workflow trigger `${{ github.sha }}`.
  - Removed the implicit fallback in `scripts/deploy-env-live-io.mjs` (`syncGithubEnvironment`) that derived `AIRINGCAL_PRODUCTION_RELEASE_SHA` from `BANGUMI_GIT_COMMIT_SHA`, `plan.gitSha`, or current `git rev-parse HEAD`. Fresh Production installations now require explicit approved release identity before any consequential remote mutation (`verifyReleaseIdentityPreflight` before bucket creation, token provisioning, or GitHub Environment creation); interactive setup discovers published release candidates for explicit operator confirmation in Configuration Review, while ordinary `update` / `recover` operations preserve the existing `AIRINGCAL_PRODUCTION_RELEASE_SHA` by default unless `AIRINGCAL_ALLOW_RELEASE_CHANGE=yes` is explicitly set (and clean up stale `AIRINGCAL_PRODUCTION_RELEASE_REF` variables when a new SHA is authorized without a ref).
  - Documented the exact GitHub Actions workflow-definition trust boundary across `README.md`, `README.zh-CN.md`, `docs/DEPLOYMENT.md`, `docs/DEPLOYMENT.zh-CN.md`, and Issue `#215` (distinguishing default-branch `schedule` workflow parsing from Environment deployment branch/tag protection rules, which block unauthorized refs rather than redirecting `schedule` triggers).
- **Schedule Contract Reconciliation (`Fix B`)**:
  - Reconciled `README.md`, `README.zh-CN.md`, `docs/DEPLOYMENT.md`, and `docs/DEPLOYMENT.zh-CN.md` with the authoritative `.github/workflows/portable-writer.yml` cron schedule (`0 20 * * *`, daily at `04:00 Asia/Shanghai` / `20:00 UTC`), with regression tests preventing schedule drift.
- **Writer Authorization Gate Separation (`Fix C`)**:
  - Clarified across workflow comments, setup scripts, and bilingual documentation that `AIRINGCAL_WRITER_ENABLED` (repository variable) is the sole gate for scheduled Production runs, `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED` (`production` environment variable) is a temporary manual `workflow_dispatch` gate that must remain `false` at rest, and `AIRINGCAL_DEVELOPMENT_WRITER_ENABLED` (`development` environment variable) gates manual Development `workflow_dispatch` runs.
- **Repository-Wide Tracked Artifact Convergence**:
  - Removed residual obsolete agent/workflow directories (`.codex/`, `.opencode/`, `.comet/`, `.playwright-cli/`, `.superpowers/`, `.codegraph/`, and the zero-byte `**WARNING**:` file), unused agent skills not declared in `AGENTS.md`, and historical benchmark/cutover receipts recoverable from `e5b3c98e6b4941a398dd4a0620c2841af2960609`.
  - Updated `.gitignore` to prevent local agent host directories, browser snapshot artifacts, and code index caches from re-entering the tracked Git tree.

---

## [3.0.0] — 2026-11-26

### Architectural Convergence (`v3.0.0`)

- **Single Supported Serverless Topology**: Converged AiringCal around **GitHub Actions Portable Writer (`.github/workflows/portable-writer.yml`) → Private Cloudflare R2 Bucket (`airingcal-production` / `airingcal-development`) → Stateless Cloudflare Reader Worker (`apps/v3-read-worker`)**.
- **Single Private Bucket per Environment**: Consolidated public release artifacts (`public/*`, `snapshots/v1/*`, `images/*`) and private SQLite checkpoints (`checkpoints/*`) into a single private R2 bucket per environment with `r2.dev` disabled and an allowlisted Worker object route interface.
- **Content-Addressed Release Lineage & CAS Lease Discipline**: Immutable SHA-256-verified snapshots and WebP cover thumbnails with compare-and-swap (CAS) checkpoint uploads, single-writer lease renewal (`checkpoints/lease.json`), and atomic release pointer commits (`public/current-release.json`).

### Safe Installation, Update, Recovery & Fork Compatibility

- **Two-Token Guided Setup Wizard (`pnpm run setup`)**: Interactive and headless setup, credential validation, and read-only Doctor diagnostics (`scripts/setup-wizard.mjs`, `scripts/deploy-env.mjs`).
- **Explicit `install | update | recover` Operation Contract**:
  - `install`: Enforces clean-bootstrap empty-bucket guards, automatic bucket-scoped Writer token provisioning (`airingcal-production-writer`), `r2.dev` disablement, and positive S3 + anonymous denial checkpoint isolation proofs.
  - `update`: Verifies existing installation ownership, Cloudflare Worker `AIRINGCAL_R2` bucket bindings, GitHub Environment variables/secrets, local inventory consistency, and existing release pointer before any mutation. Preserves nonempty buckets, snapshots, checkpoints, images, and existing GitHub Environment S3 secrets without rotating tokens.
  - `recover`: Point-of-execution mutation ledger (`scripts/mutation-ledger.mjs`) and read-only remote reconciliation (`discoverPartialState`) for safe interrupted-install recovery.
- **Truthful Credential & Isolation Verification Reporting**: Separates `presence`, `reuse`, `scopeVerification`, and `runtimeVerification` so updates reusing write-only GitHub Environment S3 secrets report `UPDATED_PARTIAL_VERIFICATION` (`not-verified-github-secret-only`) instead of claiming unexecuted S3 runtime checks.
- **Fork-Safe Repository & Dynamic Branch Resolution**: Resolves target `<owner>/<repo>` from `AIRINGCAL_REPOSITORY`, `GITHUB_REPOSITORY`, or verified `git remote get-url origin`, fails closed on source disagreement or missing origin, and dynamically resolves the active/default branch (`main` or `dev`).

### Security, Reliability & Audit Hardening

- **Writer Checkpoint Lease Release Hardening**: `runGhaPortableWriter` explicitly catches, logs (`checkpoint_lease_release_failed`), notifies, and fails the run with actionable recovery guidance if releasing `checkpoints/lease.json` fails, while preserving the primary sync summary.
- **Reader Hardening**: Added `X-Content-Type-Options: nosniff` across allowlisted public object routes (`/public/*`, `/snapshots/*`, `/images/*`) and normalized trailing slashes prior to deduplication in `parseCorsAllowedOrigins`.

### Documentation & Repository Hygiene

- **Bilingual Product Documentation**: Added English and Simplified Chinese documentation (`README.md`, `README.zh-CN.md`, `docs/DEPLOYMENT.md`, `docs/DEPLOYMENT.zh-CN.md`, `docs/API_AND_WIDGET.md`, `docs/API_AND_WIDGET.zh-CN.md`, `docs/ARCHITECTURE.md`) with genuine sanitized Reader and Widget screenshots (`docs/assets/`) and copyable AI-agent setup instructions.
- **Legacy Retirement & Recoverability Record**: Retired legacy v2 D1/KV Worker (`apps/web-worker`, `packages/worker-common`, `migrations`), historical dual-bucket Staging scripts, Comet/OpenSpec scaffolding, and deferred EdgeOne modules ([Issue #210](https://github.com/Skyline-Gazer/AiringCal/issues/210)), with full Git SHA recoverability documented in [`docs/v3/release-acceptance-evidence.md`](docs/v3/release-acceptance-evidence.md).
