# AiringCal v3.0.0 — Release Acceptance, Historical Recoverability & Governance Evidence

> Authoritative engineering evidence record for the formal `v3.0.0` software release (`Skyline-Gazer/AiringCal`).
> All secrets, tokens, personal emails, and custom domains are sanitized.

---

## 1. Specification, Plan & Authorization Lineage

| Artifact | Location / Identifier | Status |
| :--- | :--- | :--- |
| **Original Owner Release Specification** | `AiringCal v3.0.0 — Final Software Release Specification` (Project #7, Issues `#67`, `#72`, `#73`) | Owner-approved specification |
| **Consolidated Research & Initial Implementation Plan** | Branch `docs/v3.0.0-release-plan` @ commit `e6528e96738ad89c2fd206187a461b95dd794074` (`docs/plans/2026-11-26-v3.0.0-final-release-plan.md`) | Reviewed by Owner |
| **Owner Conditional Approval & Mandatory Amendments (A–F)** | `OWNER_DECISION = CONDITIONAL_GO` | Authorized full `v3.0.0` software release lifecycle |
| **Amended Implementation Plan (Amendments A–F integrated)** | Branch `docs/v3.0.0-release-plan` @ commit `b8e89061c81e88e6188bea8531fc075f6d88a2c4` | Preserved on `origin/docs/v3.0.0-release-plan` |
| **Pre-Convergence Immutable Baseline Commit** | `dev` @ `e5b3c98e6b4941a398dd4a0620c2841af2960609` | Production clean initialization & First Full Sync baseline |

---

## 2. Reconciled Production Initialization & Software Release Verdicts

AiringCal separates the **Software Release Lifecycle** from the **Personal Deployment and Operations Lifecycle**:

| Verdict Dimension | Status | Evidence / Basis |
| :--- | :--- | :--- |
| `HISTORICAL_PRODUCTION_INITIALIZATION` | `PASSED_ON_BASELINE_e5b3c98e` | Executed on `2026-11-26` at commit `e5b3c98e6b4941a398dd4a0620c2841af2960609`: private R2 bucket `airingcal-production` (`r2.dev` disabled, 4 unrelated buckets untouched), bucket-scoped Writer credential `airingcal-production-writer` (`provisioned-verified`), GitHub Environment `production` synced (9 variables + 3 secrets), Cloudflare Worker `airingcal-production` deployed, First Full Sync GitHub Actions run `45833583842` succeeded (`562` collections, `14,768` episode states, `589` subjects, `1,767` media objects published, release generation `1`), and `v3-ship-verify.mjs` passed `25/25` checks (`verdict: "READY"`). |
| `FINAL_RELEASE_SOFTWARE_ACCEPTANCE` | `PASSED` | All 10 workspace packages (`@airing-cal/bgm-api`, `domain`, `storage`, `v3-core`, `v3-builder`, `v3-read`, `v3-adapters`, `widget`, `v3-read-worker`, `node-jobs`) and deployment/setup test suites pass `pnpm typecheck`, `pnpm test`, `pnpm build:check`, `pnpm lint:undefined`, local Cloudflare Worker `wrangler dev` smoke (`staging-smoke.ts`), and local portable Reader E2E (`v3-portable-e2e.mjs`), plus the 21-scenario Controlled Provider Simulator regression matrix (`scripts/live-adapter-integration.test.mjs`). |
| `FINAL_RELEASE_LIVE_PROVIDER_ACCEPTANCE` | `QUALIFIED_BASELINE_LIVE_PLUS_SIMULATOR_ON_FINAL_SHA` | Live external Cloudflare + GitHub provider acceptance was executed on baseline commit `e5b3c98e6b4941a398dd4a0620c2841af2960609` (run `45833583842`, 25/25 live verifier checks). Per the Owner's strict non-mutation boundary, the final `v3.0.0` release candidate was verified against the stateful Controlled Provider Simulator and local `wrangler dev` / Node HTTP harnesses without mutating or redeploying the Owner's live Production or Development infrastructure. |
| `PERSONAL_PRODUCTION_UPDATE` | `DEFERRED_BY_OWNER_SCOPE` | Updating the Owner's live `airingcal-production` instance from `e5b3c98e` to `v3.0.0` is an independent personal operations action tracked in the dedicated Operational Backlog Issue. |
| `PERSONAL_PRODUCTION_CUTOVER` | `DEFERRED_BY_OWNER_SCOPE` | Enabling scheduled `portable-writer.yml` runs (`AIRINGCAL_WRITER_ENABLED=true`), binding personal custom domains, and retiring legacy v2 resources remain Owner-controlled operational tasks. |

### Sanitized Production Baseline Receipt Summary (`2026-11-26`)

- **Baseline Commit**: `e5b3c98e6b4941a398dd4a0620c2841af2960609`
- **Attempted / Deployed At**: `2026-11-26T13:51:54.089Z` → `2026-11-26T13:59:30.726Z`
- **Target Resources**:
  - R2 Bucket: `airingcal-production` (`state: "populated-and-private"`, `r2.dev` disabled, `ownershipConfirmed: true`, `unrelatedBucketCount: 4` untouched)
  - Cloudflare Worker: `airingcal-production` (`state: "deployed"`, `originMode: "worker"`)
  - GitHub Environment: `production` (`state: "synced"`, `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED=false` after First Full Sync)
  - Writer Credential: `airingcal-production-writer` (`source: "scoped-token"`, `scope: "bucket-scoped"`, `writerCredentialState: "provisioned-verified"`)
- **First Full Sync Run**: GitHub Actions run `45833583842` (`workflow_dispatch`, `target=production`, `force_mode=full`, conclusion `success`)
- **Live Verifier (`scripts/v3-ship-verify.mjs`)**: `pass: true` (`25/25` checks passed, `failed: []`)
- **Scheduled Writer Gate State**: Repository variable `AIRINGCAL_WRITER_ENABLED` is absent/closed; workflow `portable-writer.yml` is `disabled_manually`.

---

## 3. Legacy Recoverability Record (Amendment D)

The active `v3.0.0` release tree is converged to the single supported topology (**GitHub Actions Portable Writer → Private Cloudflare R2 → Cloudflare Reader Worker**). Legacy v2 D1/KV/Worker code, historical Staging dual-bucket helpers, and deferred EdgeOne Reader modules were removed from the active tree but remain **100% deterministically recoverable from Git history** whenever the Owner executes personal infrastructure retirement or historical data exports.

### Immutable Pre-Convergence Git Commit

- **Commit SHA**: `e5b3c98e6b4941a398dd4a0620c2841af2960609`
- **Archive Tag / Reference**: `e5b3c98e6b4941a398dd4a0620c2841af2960609` (ancestor of `dev` and `main`)
- **Required Toolchain**:
  - Node.js `>= 24` (`v24.x`)
  - `pnpm@9.15.9`
  - `wrangler@4.x` (via `pnpm exec wrangler`)

### Recoverable Historical Capabilities & Exact Commands

| Historical Capability | Retired Paths | Required Credentials & Authorization Gates | Executable Recovery Command (Isolated Worktree) |
| :--- | :--- | :--- | :--- |
| **Legacy v2 Cloudflare Worker (`apps/web-worker`) & D1 Migrations** | `apps/web-worker/`, `packages/worker-common/`, `migrations/`, `scripts/materialize-wrangler-config.mjs` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `git worktree add /tmp/airingcal-legacy e5b3c98e6b4941a398dd4a0620c2841af2960609 && cd /tmp/airingcal-legacy && pnpm install --frozen-lockfile` |
| **Legacy v2 D1 / KV / R2 Export & Cleanup CLIs** | `apps/node-jobs/src/cli/portable-legacy-export.ts`, `portable-legacy-cleanup.ts`, `portable-legacy-state-import.ts`, `packages/storage/src/legacy-*.ts` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, explicit `--execute` and `--confirm-delete` flags (default is read-only `--dry-run`) | `git checkout e5b3c98e6b4941a398dd4a0620c2841af2960609 -- apps/node-jobs/src/cli/portable-legacy-export.ts apps/node-jobs/src/cli/portable-legacy-cleanup.ts packages/storage/src/legacy-cleanup.ts packages/storage/src/legacy-export.ts` |
| **Historical Dual-Bucket Staging & Resource Inventory Scripts** | `scripts/setup-staging.mjs`, `scripts/inventory-cloudflare-resources.mjs`, `scripts/cleanup-cloudflare-resources.mjs`, `scripts/verify-cloudflare-resources.mjs`, `scripts/list-cloudflare-crons.mjs` | `AIRINGCAL_CLOUDFLARE_API_TOKEN`, `AIRINGCAL_CLOUDFLARE_ACCOUNT_ID` | `git checkout e5b3c98e6b4941a398dd4a0620c2841af2960609 -- scripts/inventory-cloudflare-resources.mjs scripts/cleanup-cloudflare-resources.mjs scripts/verify-cloudflare-resources.mjs` |
| **Deferred EdgeOne Reader Adapter ([Issue #210](https://github.com/Skyline-Gazer/AiringCal/issues/210))** | `apps/edgeone-read-worker/`, `packages/v3-adapters/src/edgeone*.ts`, `packages/v3-read/src/edgeone*.ts`, `apps/node-jobs/scripts/build-edgeone-read-bundle.mts` | `AIRINGCAL_EDGEONE_API_TOKEN` | `git checkout e5b3c98e6b4941a398dd4a0620c2841af2960609 -- apps/edgeone-read-worker packages/v3-adapters/src/edgeone-kv-public-store.ts packages/v3-read/src/edgeone-read-handler.ts apps/node-jobs/scripts/build-edgeone-read-bundle.mts` |
| **Historical Development Benchmark & Cutover Receipts** | `docs/v3/fixtures/reader-delivery-bench-baseline.json`, `reader-delivery-bench-post.json`, `reader-delivery-cutover-checklist.json`, `reader-delivery-cutover-parity-post.json` | None (read-only JSON artifacts) | `git checkout e5b3c98e6b4941a398dd4a0620c2841af2960609 -- docs/v3/fixtures/` |

> [!NOTE]
> **Git Source Recoverability vs. Cloud Data Backup**: Git history recoverability (`e5b3c98e6b4941a398dd4a0620c2841af2960609`) restores historical **source code, CLI tools, and committed JSON receipts**, not live cloud data in Cloudflare R2, D1, or KV. Always export or back up live cloud data (for example, via `portable-checkpoint-backup.ts` for R2 SQLite checkpoints or `portable-legacy-export.ts` for legacy v2 D1/KV data) before retiring any live cloud storage resource.

> [!CAUTION]
> Never run legacy cleanup or deletion commands against live Cloudflare or GitHub resources without explicit Owner authorization and a verified backup/export receipt.

---

## 4. ADS v0.8.0 Adoption & Consumer Evidence (`#183`)

- **Pinned Submodule**: `.ads` @ `178212c41cce8fbf9354d4066e0f77341f6f23c4` (`v0.8.0`, Lite profile).
- **Project-Level Skills Adopted for `v3.0.0`**:
  - `ponytail`, `ponytail-review`, `ponytail-audit` (`DietrichGebert/ponytail` @ `ebd8654c2c627f721eb8f9c0d1bd4090a29f9e10`, Full mode)
  - `workers-best-practices` (`cloudflare/skills` @ `ff191de7d903788eceaf516a514ae7d3b56b924a`)
  - Locked with SHA-256 content hashes in [`skills-lock.json`](../../skills-lock.json).

### T0 / T1 / T2 Observation Record & Consumer Findings

1. **T0 (Pre-adoption baseline, `2026-11-25`)**: `dev` @ `0ec26a0a`, `.ads` @ `82c3404b68995425249a022bdbeb4ac18b88fcd0` (strict ancestor of `v0.8.0`).
2. **T1 (Adoption activation, PR `#184` → `dev a7a9bb96`)**: `.ads` advanced to `178212c41cce8fbf9354d4066e0f77341f6f23c4` (`v0.8.0`).
3. **T2 (Post-adoption engineering rounds)**:
   - PRs `#185`, `#186`, `#187`: Private-R2 worker-origin public object interface, step-level environment-scoped writer gates (since GitHub Actions job-level `if:` only resolves repository-level `vars`), and positive private-object isolation proofs.
   - PR `#208` (`2026-11-26`): Resolved Test Double Fidelity (via `scripts/fixtures/controlled-provider-sim.mjs`) and Partial External Mutation Accounting (via `scripts/mutation-ledger.mjs`).
   - Release `v3.0.0` (`2026-11-26`): Applied ADS `STANDARD.md`, `SAFETY.md`, and `QUALITY.md` truthfulness rules to separate `install | update | recover` operation semantics (Amendment A), distinguish credential presence/reuse/scope from runtime S3 verification (Amendment B), enforce fork-safe repository resolution without silent fallback (Amendment C), and harden Writer checkpoint lease release failure surfacing.
   - PR `#226` (`2026-11-27`, merged as `717c36ca`): Self-service Update flow and pnpm 12 / Node 24 toolchain. ADS truthfulness applied where it changed behavior: release identity is a resolved 40-hex commit (a tag name never proves equality, `UPDATE_UNTAGGED_DIVERGED`), unreadable inputs stay unknown (unreadable release list is not `[]`, unreadable git status is not clean, unreachable Reader is not a matching Reader, unset `RELEASE_REF` yields `verify` not `current`), no silent fallback resolves a release source (`UPDATE_RELEASE_SOURCE_UNKNOWN`); `SAFETY.md` authorization limits kept the change off `main`, R2, deployments and tags; every version, flag and error code cited was observed from `npm view`, `--help`, source or a live endpoint before writing.
