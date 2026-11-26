# AiringCal v3.0.0 — Deployment, Update & Recovery Guide

[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md)

This is the single authoritative deployment and operations guide for **AiringCal `v3.0.0`**.

---

## 1. Supported Topology & Environments

AiringCal `v3.0.0` operates on a single, converged serverless architecture:

```text
GitHub Actions Portable Writer (portable-writer.yml)
  └── Private Cloudflare R2 Bucket (one bucket per environment, r2.dev disabled)
        ├── checkpoints/builder.sqlite & checkpoints/lease.json (private, never anonymously routable)
        └── public/current-release.json, snapshots/v1/*, images/* (served via allowlisted Worker routes)
              └── Stateless Cloudflare Reader Worker (apps/v3-read-worker)
```

| Environment | Canonical R2 Bucket | Canonical Cloudflare Worker | GitHub Environment | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **`production`** | `airingcal-production` | `airingcal-production` | `production` | Standard personal deployment (recommended) |
| **`development`** | `airingcal-development` | `airingcal-development` | `development` | Optional environment for testing changes |

---

## 2. Prerequisites & Credential Scope

### Local Tooling

- **Node.js `>= 24`** (`node -v`)
- **pnpm `9.15.9`** (`corepack enable && pnpm -v`)
- **GitHub CLI (`gh`)** authenticated with write/admin access to your target repository (`gh auth status`)
- **Wrangler `4.x`** (bundled in devDependencies; invoked via `pnpm exec wrangler`)

### Required API Tokens

1. **Cloudflare Management API Token** (`AIRINGCAL_CLOUDFLARE_API_TOKEN`):
   - **Account → Workers R2 Storage: Edit** (creates/inspects R2 bucket and disables `r2.dev`)
   - **Account → Workers Scripts: Edit** (deploys `airingcal-production` / `airingcal-development` and inspects Worker bindings)
   - **User → User Details: Read** (discovers accounts via `wrangler whoami`)
   - **User → API Tokens: Edit** *(recommended)*: allows the setup engine to automatically mint a dedicated, bucket-scoped Writer token (`airingcal-production-writer` or `airingcal-development-writer`) restricted to `Workers R2 Storage Bucket Item Write` on the single target bucket.
     - *Fallback*: If your management token does not include `User API Tokens: Edit`, the wizard prompts you to supply an independently created bucket-scoped R2 S3 Access Key ID and Secret Access Key via masked prompts.
   - **Zone → Zone: Read & DNS: Edit** *(optional)*: required only when attaching a Custom Domain to the Worker.
2. **Bangumi Personal Access Token** (`AIRINGCAL_BANGUMI_TOKEN`):
   - Standard Personal Access Token from [next.bgm.tv/demo/access-token](https://next.bgm.tv/demo/access-token). Used to verify your identity (`/v0/me`) and read your anime collections and episode progress.

---

## 3. Fork & Repository Resolution Contract

AiringCal is designed to work cleanly in forks and standalone repositories without editing source files:

1. **Resolution Order**:
   - Explicit `AIRINGCAL_REPOSITORY=<owner>/<repo>`
   - Trusted `GITHUB_REPOSITORY=<owner>/<repo>`
   - Verified `git remote get-url origin` (supports `https://github.com/<owner>/<repo>(.git)` and `git@github.com:<owner>/<repo>(.git)`)
2. **Fail-Closed Disagreement Guard**:
   - If multiple sources are present and disagree (for example, `AIRINGCAL_REPOSITORY` differs from `git remote origin`), setup refuses closed with `REPOSITORY_CONFLICT` unless `AIRINGCAL_REPOSITORY_OVERRIDE_CONFIRM=yes` is explicitly set.
   - Mutating operations never silently fall back to `Skyline-Gazer/AiringCal` when `origin` is missing or points to a non-GitHub host.
3. **Dynamic Branch Resolution**:
   - First Full Sync and workflow dispatches automatically resolve your checked-out branch or your repository's `default_branch` (`main` or `dev`) via the GitHub API.

---

## 4. Operation Model: `install`, `update`, and `recover`

`pnpm run setup` and the deployment engine enforce three distinct operation contracts:

### A. Fresh Installation (`install`)

Used when the target R2 bucket and Cloudflare Worker do not yet exist:

1. **Token & Account Preflight**: Verifies Cloudflare account access, `workers.dev` subdomain, and Bangumi user identity.
2. **Create Private R2 Bucket**: Creates `airingcal-production` (or `airingcal-development`).
3. **Provision Bucket-Scoped Writer Credential**: Mints `airingcal-production-writer` (after bucket creation so the bucket-scoped policy is valid), verifies token identity (`/user/tokens/verify`), reads back its policy (`/user/tokens/:id`) to prove it is restricted to the single target bucket, and verifies S3 list+head access. If any check fails, the newly created token is deleted immediately.
4. **Clean-Bootstrap Empty-Bucket Guard**: Verifies the bucket contains zero objects (`verify-bucket-empty`). Any foreign object aborts closed (`BUCKET_NOT_EMPTY`) without deleting data.
5. **Disable `r2.dev`**: Disables public `r2.dev` bucket access and verifies it is off.
6. **Sync GitHub Environment**: Creates/updates the `production` (or `development`) GitHub Environment with required variables and secrets while keeping Writer execution gates closed (`false`).
7. **Deploy Cloudflare Reader Worker**: Materializes the Wrangler config and deploys the Reader Worker bound to the bucket (`AIRINGCAL_R2`).
8. **Positive Checkpoint Isolation Proof**: Writes `checkpoints/_isolation-probe.txt`, confirms it exists via authenticated S3 `HEAD`, proves the deployed Worker denies anonymous `GET`/`HEAD` requests (including URL-encoded and path-traversal variants) with HTTP `404`, and deletes the probe object.

### B. Safe Update of an Existing Installation (`update`)

Used when an AiringCal installation already exists in your Cloudflare account and GitHub repository:

1. **Pre-Mutation Ownership & Consistency Verification (`verifyExistingInstallation`)**:
   Before any resource is created, modified, or deployed, the engine verifies:
   - The target R2 bucket exists in the selected Cloudflare account.
   - The existing Cloudflare Worker is deployed and its `AIRINGCAL_R2` binding points to the exact target R2 bucket (`WORKER_BINDING_MISMATCH` fails closed if bound elsewhere).
   - The GitHub Environment exists and its `AIRINGCAL_<ENV>_R2_BUCKET`, `CLOUDFLARE_ACCOUNT_ID`, `PRIMARY_USER_ID`, and `PUBLIC_BASE_URL` variables match your target configuration.
   - Local `.airingcal/inventory.<env>.json` (if present) does not contradict the remote repository, account, bucket, or Bangumi user ID.
   - The existing release pointer (`/public/current-release.json`) is valid on the already-deployed Worker (or the installation is a verified pre-sync empty deployment).
2. **Non-Destructive Preservation**:
   - **Never wipes or requires an empty bucket**: Existing release pointers, snapshots, manifests, SQLite checkpoints, and cover images are preserved intact.
   - **Never rotates or recreates existing Writer tokens**: Because GitHub Environment secrets (`AIRINGCAL_<ENV>_S3_*`) are write-only, `update` reuses your existing GitHub S3 secrets by default, verifies your Writer token's active status and bucket-scoped policy via the Cloudflare API, and only rotates if you explicitly supply `AIRINGCAL_WRITER_TOKEN_ROTATION_ID=<token-id>` or new `AIRINGCAL_S3_*` credentials.
   - **Does not auto-dispatch First Full Sync**: An already-initialized installation keeps its live release generation without triggering an unrequested full sync.
3. **Truthful Terminal Verdict**:
   - When updating with reused GitHub S3 secrets (without local S3 credentials), the wizard verifies anonymous checkpoint denial on the updated Worker and emits `UPDATED_PARTIAL_VERIFICATION` (`credentialVerification.runtimeVerification = "not-verified-github-secret-only"`), truthfully distinguishing Cloudflare API token scope verification from runtime S3 read/write verification.
   - When updating with local S3 credentials (or explicit token rotation) plus a passing 25-check live verifier run, the terminal verdict is `READY`.

### C. Interrupted Attempt Recovery (`recover`)

Used when a previous installation attempt was interrupted mid-flight (for example, the R2 bucket was created, but token provisioning or network transport failed):

1. Uses the point-of-execution mutation ledger (`.airingcal/inventory.<env>.json`) and read-only remote reconciliation (`discoverPartialState`) to report confirmed mutations, existing resources, and any unknown transport outcomes.
2. Adopts the empty pre-existing bucket after ownership proof (or explicit Owner confirmation) while keeping the clean-bootstrap empty-bucket guard active.
3. Presents context-sensitive recovery actions: **Supply or Replace Independent R2 S3 Credential**, **Reconcile Existing Resources**, **Retry Failed Operation**, **Return to Configuration Review**, **View Detailed Failure Report**, or **Exit Safely**.

---

## 5. Interactive Setup Walkthrough (`pnpm run setup`)

Run the setup wizard from the repository root:

```bash
pnpm run setup
```

### Command-Line Flags for `pnpm run setup`

| Command | Mode | Description |
| :--- | :--- | :--- |
| `pnpm run setup` | Interactive Menu | Full interactive TUI: Install or Update, Validate API Credentials, Doctor |
| `pnpm run setup -- --doctor --environment production` | Read-Only Doctor | Checks `gh auth`, `portable-writer.yml` workflow state, environment gate, schedule gate, and recent runs |
| `pnpm run setup -- --headless --environment production` | Headless Apply | Non-interactive execution driven by `.env.production` and explicit confirmation gates |
| `pnpm run setup -- --sync --environment production` | Standalone First Sync | Dispatches a gated First Full Sync (`portable-writer.yml`, `force_mode=full`) with automatic gate cleanup |

---

## 6. Headless / Non-Interactive Execution

For scripted or CI-assisted environments, you can run the deployment engine non-interactively using an isolated dotenv file (`.env.production` for Production, `.env` for Development).

### Required `.env.production` Variables (Mode `0600`, Gitignored)

```dotenv
AIRINGCAL_ENV=production
AIRINGCAL_DEPLOY_TARGET=cloudflare
AIRINGCAL_REPOSITORY=<your-owner>/<your-repo>
AIRINGCAL_CLOUDFLARE_API_TOKEN=<your-cloudflare-api-token>
AIRINGCAL_CLOUDFLARE_ACCOUNT_ID=<your-32-hex-account-id>
AIRINGCAL_WORKERS_DEV_SUBDOMAIN=<your-workers-dev-subdomain>
AIRINGCAL_BANGUMI_TOKEN=<your-bangumi-pat>
AIRINGCAL_PRIMARY_USER_ID=<your-bangumi-numeric-user-id>
AIRINGCAL_USERS_JSON=[{"userId":"<your-bangumi-numeric-user-id>","username":"<your-bangumi-username>"}]

# Optional: set to "update" when updating an existing initialized installation
# AIRINGCAL_OPERATION=update

# Optional: Custom Domain (omit for default workers.dev origin)
# AIRINGCAL_PUBLIC_BASE_URL=https://anime.example.com
# AIRINGCAL_WORKER_CUSTOM_DOMAIN=anime.example.com
# AIRINGCAL_ZONE_ID=<your-cloudflare-zone-id>
```

### Step 1 — Dry-Run Plan Preview (Read-Only)

```bash
AIRINGCAL_ENV=production \
AIRINGCAL_DOTENV_PATH=.env.production \
node scripts/deploy-env.mjs --dry-run --target cloudflare
```

### Step 2 — Authorized Apply

Production mutations require three explicit authorization signals (`--apply --i-am-sure-production`, `AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes`, and `AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes`):

```bash
AIRINGCAL_ENV=production \
AIRINGCAL_DOTENV_PATH=.env.production \
AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes \
AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes \
node scripts/deploy-env.mjs --apply --i-am-sure-production --target cloudflare
```

---

## 7. Live Verification (`scripts/v3-ship-verify.mjs`)

After your First Full Sync (or after an update when local S3 credentials are available), verify the live deployment end-to-end:

```bash
AIRINGCAL_S3_ACCESS_KEY_ID=<your-bucket-s3-key-id> \
AIRINGCAL_S3_SECRET_ACCESS_KEY=<your-bucket-s3-secret-key> \
AIRINGCAL_S3_ACCOUNT_ID=<your-32-hex-account-id> \
node scripts/v3-ship-verify.mjs \
  --base https://airingcal-production.<your-subdomain>.workers.dev \
  --bucket airingcal-production
```

What `v3-ship-verify.mjs` checks (25 checks total):
1. **Positive Private-Object Isolation**: Uses S3 `HEAD` to confirm `checkpoints/builder.sqlite` (or a temporary probe object) genuinely exists in the private R2 bucket, then verifies that anonymous `GET`/`HEAD` requests against `/checkpoints/builder.sqlite`, `/checkpoints/lease.json`, URL-encoded `%63heckpoints`, and path-traversal `/public/..%2f..%2fcheckpoints/*` all return HTTP `403`/`404`.
2. **Release Pointer & Snapshot Integrity**: Verifies `/public/current-release.json` (`Cache-Control: public, max-age=0, must-revalidate`) and the referenced immutable snapshot `/snapshots/v1/<gen>-<sha>.json` (`Cache-Control: public, max-age=31536000, immutable`).
3. **Reader API & Widget Contract**: Verifies `/`, `/src/bangumi.js`, `/src/bangumi.css`, `/api/health`, `/api/collections?type=watching`, `/api/calendar`, `/api/config?key=nsfw`, `/api/version`, `/api/sync/apply` (HTTP `410`), and cover image streaming `/image/:hash`.

> [!NOTE]
> If you only want to verify the public HTTP and anonymous denial surface without local S3 credentials, pass `--allow-unproven-isolation` instead of `--bucket`. Note that `--allow-unproven-isolation` checks anonymous route denial only and does not prove private object existence in R2.

---

## 8. Enabling or Disabling the Scheduled Portable Writer

The GitHub Actions workflow `.github/workflows/portable-writer.yml` is protected by a **two-level gate**:

1. **Repository-Level Schedule Gate** (`vars.AIRINGCAL_WRITER_ENABLED`):
   - Controls whether the 6-hour cron (`17 */6 * * *`) runs at all.
   - Enable: `gh variable set AIRINGCAL_WRITER_ENABLED --repo <owner>/<repo> --body true`
   - Disable: `gh variable set AIRINGCAL_WRITER_ENABLED --repo <owner>/<repo> --body false`
2. **Environment-Level Job Gate**:
   - `production` environment variable: `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED` (`true` or `false`)
   - `development` environment variable: `AIRINGCAL_DEVELOPMENT_WRITER_ENABLED` (`true` or `false`)
   - Set for Production:
     ```bash
     gh variable set AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED --env production --repo <owner>/<repo> --body true
     ```

### Manual One-Shot Sync Dispatch

You can trigger an on-demand incremental or full sync at any time:

```bash
# Temporarily open the environment gate, dispatch, and close automatically via the setup wizard:
pnpm run setup -- --sync --environment production

# Or dispatch manually via GitHub CLI (when the environment gate is true):
gh workflow run portable-writer.yml --repo <owner>/<repo> -f target=production -f force_mode=incremental
```

---

## 9. Local Inventory & Troubleshooting

- **Sanitized Local Inventory (`.airingcal/inventory.<env>.json`)**:
  - Created with file mode `0600` and gitignored.
  - Records your resolved repository, Cloudflare account ID (with email addresses redacted), bucket state, Worker URL, Writer credential metadata (`source`, `scope`, `tokenName`, `tokenId` — never secret values), point-of-execution mutation receipts, and verification results.
- **Common Error Codes & Remediation**:
  - `REPOSITORY_CONFLICT` / `REPOSITORY_UNRESOLVED`: `AIRINGCAL_REPOSITORY`, `GITHUB_REPOSITORY`, and `git remote get-url origin` disagree or `origin` is missing. Set `AIRINGCAL_REPOSITORY=<owner>/<repo>` (and `AIRINGCAL_REPOSITORY_OVERRIDE_CONFIRM=yes` if intentionally overriding `origin`).
  - `BUCKET_NOT_EMPTY`: Fresh `install` or `recover` found pre-existing objects in the target bucket. If this is an existing AiringCal installation, run in `update` mode (`AIRINGCAL_OPERATION=update` or via `pnpm run setup` after deploying the Worker/Environment); if the bucket belongs to another project, do not use it.
  - `WORKER_BINDING_MISMATCH`: The existing Cloudflare Worker binds `AIRINGCAL_R2` to a different R2 bucket than expected. Inspect the Worker bindings in the Cloudflare dashboard before updating.
  - `FOREIGN_OR_INCONSISTENT_INSTALLATION`: Remote GitHub Environment variables, Worker bindings, or local inventory conflict with the target account, bucket, or Bangumi user ID.
  - `OWNERSHIP_EVIDENCE_INSUFFICIENT`: A transport or permission error prevented the engine from reading bucket, Worker, or GitHub Environment metadata before an update. Verify your Cloudflare API token scopes and `gh auth status`.
  - `Checkpoint lease held by <owner> until <unix>`: Another Writer run holds `checkpoints/lease.json` (45-minute TTL). Wait for the active run to finish or for TTL expiry; if a crashed run failed to release its lease, inspect `checkpoints/lease.json` in R2.
