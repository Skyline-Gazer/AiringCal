# AiringCal

**Your personal Bangumi anime calendar & progress tracker — self-hosted on Cloudflare Workers and private R2 with zero servers to maintain.**

[English](README.md) | [简体中文](README.zh-CN.md)

---

## What Is AiringCal?

**AiringCal** is an open-source personal anime collection and weekly airing calendar viewer powered by your [Bangumi (bgm.tv)](https://bgm.tv) account.

It synchronizes your anime collections (`watching`, `want`, `watched`, `on_hold`, `dropped`), episode watch progress, weekly broadcast schedule, and cover thumbnails into a **private Cloudflare R2 bucket** via a **one-shot GitHub Actions Portable Writer**, and serves a fast, responsive web Reader and embeddable Widget from a **stateless Cloudflare Worker**.

![AiringCal Desktop Reader](docs/assets/reader-desktop.png)

<p align="center">
  <img src="docs/assets/reader-mobile.png" alt="AiringCal Mobile Reader" width="32%" />
  &nbsp;&nbsp;
  <img src="docs/assets/widget-embed.png" alt="AiringCal Embedded Widget" width="64%" />
</p>

### Key Capabilities

- **Weekly Airing Calendar & Collection Tabs**: Browse your active watching list, completed series, backlog, and 7-day airing schedule with instant search, sort, and progress bars.
- **Embeddable Personal Blog Widget**: Drop a single `<script>` and `<link>` tag into any personal blog or static site (Hexo, Hugo, Astro, VitePress, Next.js) to display your live anime progress.
- **Single-Bucket Private-R2 Security**: Only one private R2 bucket per environment (`airingcal-production` or `airingcal-development`). `r2.dev` is disabled; public release objects (`public/*`, `snapshots/*`, `images/*`) are served strictly through an allowlisted Cloudflare Worker route while internal SQLite checkpoints (`checkpoints/*`) are never anonymously reachable.
- **Two-Token Guided Setup (`pnpm run setup`)**: Interactive and headless setup wizard that discovers your Cloudflare account, `workers.dev` subdomain, and Bangumi identity, provisions a bucket-scoped R2 Writer credential, configures your GitHub Environment, deploys the Cloudflare Reader Worker, and verifies isolation.
- **Safe Install, Update & Recovery Contract**: Explicitly distinguishes `install`, `update`, and `recover` operations. Updating an existing installation verifies resource ownership and Worker R2 bindings before any mutation and preserves your existing bucket data, release lineage, checkpoints, images, and Writer secrets.
- **Fork-First Compatibility**: Automatically resolves your fork's `<owner>/<repo>` and default branch without hardcoded upstream repository or branch assumptions.

---

## Architecture Overview

```text
┌──────────────────────┐      Scheduled / Manual       ┌───────────────────────────────────┐
│   Bangumi API        │ ────────────────────────────▶ │  GitHub Actions Portable Writer   │
│   (api.bgm.tv)       │   Collections + Ep Progress   │  (.github/workflows/              │
└──────────────────────┘                               │   portable-writer.yml)            │
                                                       └─────────────────┬─────────────────┘
                                                                         │
                                                     CAS Lease + Atomic  │ S3 API (Bucket-Scoped Token)
                                                     Release Pointer     ▼
                                                       ┌───────────────────────────────────┐
                                                       │  Private Cloudflare R2 Bucket     │
                                                       │  • checkpoints/builder.sqlite     │
                                                       │  • checkpoints/lease.json         │
                                                       │  • snapshots/v1/<gen>-<sha>.json  │
                                                       │  • public/current-release.json    │
                                                       │  • images/<sha256>/{original,...} │
                                                       └─────────────────┬─────────────────┘
                                                                         │
                                                      Native R2 Binding  │ (AIRINGCAL_R2)
                                                                         ▼
┌──────────────────────┐     HTTPS (Viewer / JSON)     ┌───────────────────────────────────┐
│  Browser / Blog      │ ◀──────────────────────────── │  Cloudflare Reader Worker         │
│  Widget / RSS-like   │     Immutable Edge Cache      │  (apps/v3-read-worker)            │
└──────────────────────┘                               └───────────────────────────────────┘
```

- **Supported Environments**: `production` (`airingcal-production`) and `development` (`airingcal-development`).
- **Write Plane**: GitHub Actions (`portable-writer.yml`) restores `checkpoints/builder.sqlite` from R2, runs incremental synchronization (with automatic full reconciliation every N days, default 7), uploads content-addressed cover thumbnails and snapshots, renews its CAS lease, and atomically commits `public/current-release.json`.
- **Read Plane**: Cloudflare Worker (`apps/v3-read-worker`) serves the Web UI (`/`), Widget assets (`/src/bangumi.js`, `/src/bangumi.css`), v2-compatible JSON APIs (`/api/collections`, `/api/calendar`, `/api/health`, `/api/config`, `/api/version`), and content-addressed images (`/image/:hash`).

---

## Prerequisites

Before installing or developing AiringCal, ensure your environment meets these requirements:

| Requirement | Version / Scope | Notes |
| :--- | :--- | :--- |
| **Node.js** | `>= 24` (`v24.x`) | Required by the workspace (`engines.node: ">=24"`) and native SQLite builder (`node:sqlite`) |
| **pnpm** | `9.15.9` (`packageManager`) | Enable via `corepack enable` |
| **GitHub CLI (`gh`)** | Authenticated (`gh auth status`) | Must have write/admin access to your target repository/fork |
| **Cloudflare Account** | Free or Paid plan with **Workers** & **R2** enabled | Ensure your `workers.dev` subdomain is registered once in the Cloudflare dashboard |
| **Cloudflare API Token** | Account: `Workers R2 Storage:Edit`, `Workers Scripts:Edit`<br>User: `User Details:Read`, `API Tokens:Edit` *(or supply an independent bucket-scoped R2 S3 key)*<br>Zone *(optional, Custom Domain only)*: `Zone:Read`, `DNS:Edit` | Create at [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) |
| **Bangumi Personal Access Token** | Standard personal access token | Create at [Bangumi Access Token](https://next.bgm.tv/demo/access-token) |

---

## Quick Start: Install, Update & Recover

### 1. Fork & Clone

1. Fork this repository on GitHub (or use your own repository copy).
2. Clone your repository locally, optionally check out the formal release tag `v3.0.0` (or `main`), and install dependencies:

```bash
git clone https://github.com/<your-owner>/<your-repo>.git
cd AiringCal
# Optional: check out the immutable formal release tag v3.0.0 (or main).
# Note: `dev` is the integration branch containing post-v3.0.0 unreleased maintenance hardening.
git checkout v3.0.0
corepack enable
pnpm install --frozen-lockfile
```

### 2. Run the Interactive Setup Wizard (`pnpm run setup`)

```bash
pnpm run setup
```

The wizard guides you through:

1. **Menu Action**: Choose **Install or Update**, **Validate API Credentials** (read-only preflight), or **Doctor** (read-only health check).
2. **Environment Selection**: Choose **Production** (recommended for personal use) or **Development**.
3. **Credential Validation**: Paste your Cloudflare API Token and Bangumi Personal Access Token (masked input; kept in session memory only, never echoed or committed).
4. **Automatic Discovery**: Discovers your Cloudflare Account ID, `workers.dev` subdomain, Bangumi user ID/username, and existing installation state (`install`, `update`, or `recover`).
5. **Domain Choice**: Use your default `https://airingcal-production.<subdomain>.workers.dev` URL (no DNS changes required) or attach a Custom Domain from a Cloudflare zone in the same account.
6. **Plan Review & Apply**:
   - **Fresh Install (`install`)**: Creates private R2 bucket `airingcal-production`, provisions bucket-scoped Writer token `airingcal-production-writer`, verifies bucket emptiness, disables `r2.dev`, syncs GitHub Environment `production`, deploys the Cloudflare Worker, and proves checkpoint route isolation.
   - **Existing Installation (`update`)**: Verifies bucket ownership, Worker R2 binding (`AIRINGCAL_R2`), GitHub Environment consistency, and existing release pointer **before** any mutation. Preserves all existing bucket objects, snapshots, checkpoints, images, and GitHub S3 secrets while redeploying the updated Cloudflare Reader Worker.
   - **Interrupted Attempt (`recover`)**: Reconciles partial resources and safely resumes after explicit confirmation.
7. **First Full Sync**: For a new installation, optionally authorizes and dispatches the initial `portable-writer.yml` Full Sync run in GitHub Actions (opening and closing the temporary bootstrap gate automatically) and runs the 25-check live verifier (`scripts/v3-ship-verify.mjs`).

---

## AI-Native Installation & Update Instructions

If you use an AI coding agent (Claude Code, Cursor, Antigravity, Windsurf, OpenAI Codex, etc.), copy and paste the prompt block below into your agent:

```markdown
You are operating inside an AiringCal repository checkout. Follow these exact rules to install, update, or diagnose AiringCal:

1. Read `docs/DEPLOYMENT.md` first. Never guess CLI flags or environment variable names.
2. Verify prerequisites (read-only):
   - `node -v` (must be >= 24)
   - `pnpm -v` (9.x)
   - `gh auth status`
   - `git remote get-url origin` (must point to the user's GitHub repository/fork)
3. For read-only diagnostics of an existing setup, run:
   - `pnpm run setup -- --doctor --environment production`
4. Prefer the interactive wizard (`pnpm run setup`) in a user terminal so credentials are entered via masked prompts and never appear in chat logs or shell history.
5. If the user explicitly requests non-interactive/headless execution using a local `.env.production` file (mode 0600, gitignored), verify the target repository (`AIRINGCAL_REPOSITORY=<owner>/<repo>`), preview the dry-run plan first (`AIRINGCAL_ENV=production AIRINGCAL_DOTENV_PATH=.env.production node scripts/deploy-env.mjs --dry-run --target cloudflare`), and require explicit user confirmation before setting `AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes` and `AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes`.
6. Never print, log, or commit secret values (`AIRINGCAL_CLOUDFLARE_API_TOKEN`, `AIRINGCAL_BANGUMI_TOKEN`, `AIRINGCAL_S3_*`).
```

---

## Embedding the Widget & Using the API

### Standalone Web Reader

Your deployed Cloudflare Worker serves the full standalone Reader UI at its root URL:

```text
https://airingcal-production.<your-subdomain>.workers.dev/
```

### Embed in Your Personal Website or Blog

To embed AiringCal on an external domain (e.g., `https://blog.example.com`), add your blog origin to `AIRINGCAL_CORS_ORIGINS` and include the stylesheet and script:

```html
<link rel="stylesheet" href="https://airingcal-production.<your-subdomain>.workers.dev/src/bangumi.css">

<div class="bgm-container"></div>

<script>
  window.bgmConfig = {
    apiUrl: 'https://airingcal-production.<your-subdomain>.workers.dev',
    quote: 'Tracking anime via Bangumi & AiringCal'
  };
</script>
<script src="https://airingcal-production.<your-subdomain>.workers.dev/src/bangumi.js"></script>
```

### Public Read API Summary

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/` | `GET`, `HEAD` | Standalone HTML Reader page |
| `/src/bangumi.js`, `/src/bangumi.css` | `GET`, `HEAD` | Embeddable Widget script and stylesheet |
| `/api/collections?type=watching&page=1&limit=24&nsfw=hide` | `GET`, `HEAD` | Paginated anime collections (`watching`, `want`, `watched`, `on_hold`, `dropped`); `nsfw=hide` filters before pagination |
| `/api/calendar` | `GET`, `HEAD` | 7-day airing calendar enriched with personal collection status |
| `/api/health` | `GET`, `HEAD` | Release generation, publish timestamp, subject counts, and scheduler status |
| `/api/config?key=nsfw` | `GET`, `HEAD` | Public reader configuration (`nsfw` visibility flag) |
| `/api/version` | `GET`, `HEAD` | Runtime platform (`cloudflare`), schema version, and package version (`3.0.0`) |
| `/image/:sha256`, `/image/:sha256/thumb` | `GET`, `HEAD` | Content-addressed WebP cover thumbnail or original cover image |
| `/public/current-release.json` | `GET`, `HEAD` | Current immutable release pointer |

See **[`docs/API_AND_WIDGET.md`](docs/API_AND_WIDGET.md)** for full query parameters, response schemas, caching semantics, and CORS details.

---

## Enabling Scheduled Synchronization

By default, `pnpm run setup` leaves the recurring schedule gate **disabled** so you stay in full control of GitHub Actions usage. The scheduled Portable Writer runs **once daily at `04:00 Asia/Shanghai` (`20:00 UTC`, cron `0 20 * * *`)** against **`production` only** (`development` is manual `workflow_dispatch` only).

Once your First Full Sync is verified:

1. Verify that your `production` GitHub Environment records the explicitly approved 40-character release commit SHA in `AIRINGCAL_PRODUCTION_RELEASE_SHA` (and optional immutable release tag `AIRINGCAL_PRODUCTION_RELEASE_REF`, e.g. `v3.0.0`, which must resolve to that exact commit SHA; never use an arbitrary unreviewed `dev` HEAD):
   ```bash
   gh variable set AIRINGCAL_PRODUCTION_RELEASE_SHA --env production --repo <owner>/<repo> --body "$(git rev-parse v3.0.0^{commit})"
   gh variable set AIRINGCAL_PRODUCTION_RELEASE_REF --env production --repo <owner>/<repo> --body "v3.0.0"
   ```
2. Keep the manual bootstrap gate `AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED` set to `false` at rest (it gates manual `workflow_dispatch` runs only and must **never** be left `true` permanently for scheduled runs).
3. Enable the repository-level schedule gate variable and ensure `portable-writer.yml` is active:
   ```bash
   gh variable set AIRINGCAL_WRITER_ENABLED --repo <owner>/<repo> --body true
   gh workflow enable portable-writer.yml --repo <owner>/<repo>
   ```

> **Note on GitHub Actions Schedule, Default Branch & Environment Policy Mechanics**:
> - GitHub Actions `schedule` triggers always parse and execute the workflow YAML definition from the repository's **default branch** (`refs/heads/<default_branch>`).
> - Within that run, the `production` job pins and verifies the checked-out executable source tree (`pnpm install`, bundle build, `scripts/gha-portable-writer.sh`, and `BANGUMI_GIT_COMMIT_SHA`) against `AIRINGCAL_PRODUCTION_RELEASE_SHA`.
> - GitHub Environment `production` deployment branch/tag protection rules enforce which branches/tags may access the `production` environment; they do **not** redirect a `schedule` trigger to another branch. Therefore, setting `main` as default branch and configuring a `production` Environment branch/tag policy are **not** interchangeable alternatives: if your repository's default branch remains `dev` while the `production` Environment policy rejects `dev` (allowing only `main` or `v*`), scheduled Production runs will be **blocked** by GitHub Actions rather than redirected to `main`.
> - Conversely, switching the repository default branch to `main` *before* the hardened `.github/workflows/portable-writer.yml` definition has been formally released to `main` would run the older `main` workflow definition. Required reviewer policies on the `production` Environment also pause unattended scheduled runs awaiting manual approval.

---

## Known Limitations & Deferred Scope

- **Cloudflare-Only Reader in `v3.0.0`**: Cloudflare Workers + Private R2 is the sole supported production deployment topology in `v3.0.0`. Additional reader platform candidates (Tencent EdgeOne Pages/Makers, Vercel, Netlify) are tracked in [#210](https://github.com/Skyline-Gazer/AiringCal/issues/210); Cloudflare-native and AI-native installation experience research (plus sanitized Public Demo) is tracked in [#211](https://github.com/Skyline-Gazer/AiringCal/issues/211); and installation blog guides are tracked in [#212](https://github.com/Skyline-Gazer/AiringCal/issues/212).
- **Unreadable GitHub Secrets on Update**: GitHub Actions Environment secrets (`AIRINGCAL_PRODUCTION_S3_*`) are write-only and cannot be read back locally. When updating an existing installation without supplying local `AIRINGCAL_S3_*` credentials, `pnpm run setup` preserves your existing GitHub secrets and verifies your Writer token's active status and bucket-scoped policy via the Cloudflare API, reporting runtime S3 verification as `UPDATED_PARTIAL_VERIFICATION` (`not-verified-github-secret-only`).

---

## Documentation Index

- **Deployment, Update & Recovery Guide**: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | [简体中文](docs/DEPLOYMENT.zh-CN.md)
- **HTTP Read API & Widget Integration**: [`docs/API_AND_WIDGET.md`](docs/API_AND_WIDGET.md) | [简体中文](docs/API_AND_WIDGET.zh-CN.md)
- **System Architecture & Security Model**: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Portable Writer Operator Contract**: [`apps/node-jobs/docs/operator-contract.md`](apps/node-jobs/docs/operator-contract.md)
- **Release Acceptance & Legacy Recoverability Evidence**: [`docs/v3/release-acceptance-evidence.md`](docs/v3/release-acceptance-evidence.md)
- **Release History**: [`CHANGELOG.md`](CHANGELOG.md)
