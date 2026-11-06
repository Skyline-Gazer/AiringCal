#!/usr/bin/env bash
# Idempotent, `.env`-driven one-shot Staging initialization & Read Worker deployment (#147).
#
# Reads root `.env` safely via `scripts/setup-staging-lib.mjs` (never `source .env`,
# preventing command injection and never overwriting `.env`).
#
# Automates:
#  1. Wrangler & GitHub CLI auth/permission checks (Skyline-Gazer/AiringCal only).
#  2. Create or reuse R2 buckets `airingcal-staging-checkpoint` & `airingcal-staging-public`.
#  3. Disable public access on Checkpoint bucket and verify it stays private;
#     enable HTTPS (`r2.dev`) access on Public bucket.
#  4. Resolve Bangumi user via Bangumi API (`/v0/users/{username}` / `/v0/me`) and
#     auto-generate `AIRINGCAL_STAGING_USERS_JSON`.
#  5. Create or reuse GitHub `staging` Environment.
#  6. Sync non-sensitive Variables to GitHub `staging` Environment.
#  7. Sync Secrets via stdin (`gh secret set --env staging`) without logging values.
#  8. Materialize staging Wrangler config (`scripts/materialize-v3-read-staging-config.mjs`).
#  9. Deploy Staging Read Worker (`airing-cal-v3-read-staging`) with `--env-file /dev/null`
#     so `.env` is never uploaded to the remote Worker.
# 10. Verify buckets, binding, HTTPS URL and Worker `/api/version` + `/api/health`
#     (distinguishing initial 503 `NO_RELEASE` from a real post-publish 200 PASS).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="/usr/local/bin:${PATH:-}"
export AIRINGCAL_DOTENV_PATH="${AIRINGCAL_DOTENV_PATH:-$ROOT/.env}"

DRY_RUN=0
SKIP_DEPLOY=0

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-staging.sh [options]

Options:
  --env-file <path>           Path to local .env file (default: <repo>/.env).
  --dry-run                   Validate .env / CLI inputs, resolve user config, derive
                              variables, and materialize staging Wrangler config without
                              calling remote Cloudflare/GitHub mutation APIs.
  --skip-deploy               Complete bucket & GitHub Environment setup without deploying Worker.
  --primary-user-id <id>      Override AIRINGCAL_STAGING_PRIMARY_USER_ID.
  --username <name>           Explicit Bangumi username override.
  --users-json <json>         Explicit AIRINGCAL_STAGING_USERS_JSON override.
  --public-base-url <url>     Explicit AIRINGCAL_STAGING_PUBLIC_BASE_URL override.
  --account-id <hex32>        Explicit AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID override.
  -h, --help                  Show this help message.

Local `.env` configuration (see `.env.example`):
  AIRINGCAL_STAGING_BANGUMI_TOKEN=
  AIRINGCAL_STAGING_PRIMARY_USER_ID=
  AIRINGCAL_STAGING_S3_ACCESS_KEY_ID=
  AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY=
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      export AIRINGCAL_DOTENV_PATH="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-deploy)
      SKIP_DEPLOY=1
      shift
      ;;
    --primary-user-id)
      export AIRINGCAL_STAGING_PRIMARY_USER_ID="${2:-}"
      shift 2
      ;;
    --username)
      export AIRINGCAL_STAGING_BANGUMI_USERNAME="${2:-}"
      shift 2
      ;;
    --users-json)
      export AIRINGCAL_STAGING_USERS_JSON="${2:-}"
      shift 2
      ;;
    --public-base-url)
      export AIRINGCAL_STAGING_PUBLIC_BASE_URL="${2:-}"
      shift 2
      ;;
    --account-id)
      export AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/airingcal-staging-setup.XXXXXX")"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

GIT_SHA="$(git rev-parse HEAD)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  export AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID="${AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-0123456789abcdef0123456789abcdef}}"
  export AIRINGCAL_STAGING_PUBLIC_BASE_URL="${AIRINGCAL_STAGING_PUBLIC_BASE_URL:-https://pub-staging-dryrun.r2.dev}"
  DERIVED_JSON="$(node scripts/setup-staging-lib.mjs derive)"
  PUBLIC_BUCKET="$(printf '%s' "$DERIVED_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).variables.AIRINGCAL_STAGING_PUBLIC_R2_BUCKET))')"
  PUBLIC_URL="$(printf '%s' "$DERIVED_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).variables.AIRINGCAL_STAGING_PUBLIC_BASE_URL))')"
  AIRINGCAL_STAGING_PUBLIC_R2_BUCKET="$PUBLIC_BUCKET" \
  AIRINGCAL_STAGING_PUBLIC_BASE_URL="$PUBLIC_URL" \
  BANGUMI_GIT_COMMIT_SHA="$GIT_SHA" \
    node scripts/materialize-v3-read-staging-config.mjs \
      apps/v3-read-worker/wrangler.toml \
      "$TEMP_DIR/wrangler-v3-read-staging.toml" >/dev/null
  printf '%s
' "$DERIVED_JSON"
  exit 0
fi

REPO="${AIRINGCAL_REPOSITORY:-Skyline-Gazer/AiringCal}"
ENV_NAME="${AIRINGCAL_TARGET_ENVIRONMENT:-staging}"
if [[ "$REPO" != "Skyline-Gazer/AiringCal" ]]; then
  echo "Cross-repository guard: refusing to operate on $REPO" >&2
  exit 1
fi
if [[ "$ENV_NAME" != "staging" ]]; then
  echo "Cross-environment guard: refusing to operate on environment $ENV_NAME" >&2
  exit 1
fi

# Load optional Cloudflare token from .env into CLOUDFLARE_API_TOKEN for Wrangler CLI calls
CF_TOKEN_FROM_DOTENV="$(node scripts/setup-staging-lib.mjs read-cf-token)"
if [[ -n "$CF_TOKEN_FROM_DOTENV" && -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  export CLOUDFLARE_API_TOKEN="$CF_TOKEN_FROM_DOTENV"
fi

# Step 1: Verify GitHub CLI & Wrangler authentication and permissions
echo "[1/10] Checking GitHub CLI and Wrangler authentication..."
gh auth status >/dev/null
REPO_CHECK="$(gh api "repos/${REPO}" --jq '.full_name')"
if [[ "$REPO_CHECK" != "$REPO" ]]; then
  echo "GitHub CLI cannot access ${REPO}" >&2
  exit 1
fi

WHOAMI_JSON="$(pnpm exec wrangler --env-file /dev/null whoami --json)"
if [[ -z "${AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    export AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
  else
    export AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "$WHOAMI_JSON" | node scripts/setup-staging-lib.mjs parse-whoami)"
  fi
fi
export CLOUDFLARE_ACCOUNT_ID="$AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID"

# Verify actual R2 permission before mutating anything
pnpm exec wrangler --env-file /dev/null r2 bucket list >/dev/null

CHECKPOINT_BUCKET="${AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET:-airingcal-staging-checkpoint}"
PUBLIC_BUCKET="${AIRINGCAL_STAGING_PUBLIC_R2_BUCKET:-airingcal-staging-public}"

# Step 2: Create or reuse staging R2 buckets (idempotent; never empties existing buckets)
echo "[2/10] Ensuring isolated staging R2 buckets (${CHECKPOINT_BUCKET}, ${PUBLIC_BUCKET})..."
for bucket in "$CHECKPOINT_BUCKET" "$PUBLIC_BUCKET"; do
  case "$bucket" in
    airing-cal-public|airing-cal-images|airing-cal-data|airing-cal-checkpoint)
      echo "Refusing to touch production bucket: $bucket" >&2
      exit 1
      ;;
  esac
  if pnpm exec wrangler --env-file /dev/null r2 bucket info "$bucket" --json >/dev/null 2>&1; then
    echo "  Reused existing R2 bucket: $bucket"
  else
    pnpm exec wrangler --env-file /dev/null r2 bucket create "$bucket" >/dev/null
    echo "  Created R2 bucket: $bucket"
  fi
done

# Step 3: Disable public access on Checkpoint bucket (must not fail silently) & verify private;
#         enable public HTTPS r2.dev access on Public bucket
echo "[3/10] Enforcing private checkpoint bucket and enabling public HTTPS r2.dev URL..."
pnpm exec wrangler --env-file /dev/null r2 bucket dev-url disable "$CHECKPOINT_BUCKET" -y >/dev/null
CHECKPOINT_DEV_URL_STATUS="$(pnpm exec wrangler --env-file /dev/null r2 bucket dev-url get "$CHECKPOINT_BUCKET")"
printf '%s' "$CHECKPOINT_DEV_URL_STATUS" | node scripts/setup-staging-lib.mjs assert-checkpoint-private "$CHECKPOINT_BUCKET"

pnpm exec wrangler --env-file /dev/null r2 bucket dev-url enable "$PUBLIC_BUCKET" -y >/dev/null
DEV_URL_OUT="$(pnpm exec wrangler --env-file /dev/null r2 bucket dev-url get "$PUBLIC_BUCKET")"
if [[ -z "${AIRINGCAL_STAGING_PUBLIC_BASE_URL:-}" ]]; then
  export AIRINGCAL_STAGING_PUBLIC_BASE_URL="$(printf '%s' "$DEV_URL_OUT" | node scripts/setup-staging-lib.mjs parse-dev-url)"
fi

# Step 4: Resolve Bangumi user via Bangumi API and derive all non-sensitive variables
echo "[4/10] Resolving Bangumi user and deriving staging configuration..."
DERIVED_JSON="$(node scripts/setup-staging-lib.mjs derive)"
WORKER_NAME="$(printf '%s' "$DERIVED_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).variables.AIRINGCAL_STAGING_WORKER_NAME))')"
RESOLVED_PUBLIC_BUCKET="$(printf '%s' "$DERIVED_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).variables.AIRINGCAL_STAGING_PUBLIC_R2_BUCKET))')"
RESOLVED_PUBLIC_URL="$(printf '%s' "$DERIVED_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).variables.AIRINGCAL_STAGING_PUBLIC_BASE_URL))')"

# Step 5: Create or reuse GitHub `staging` Environment
echo "[5/10] Ensuring GitHub '${ENV_NAME}' Environment on ${REPO}..."
gh api --method PUT "repos/${REPO}/environments/${ENV_NAME}" >/dev/null

# Step 6 & 7: Sync Variables and Secrets to GitHub `staging` Environment via controlled Node helper
echo "[6-7/10] Syncing Variables and Secrets to GitHub '${ENV_NAME}' Environment..."
SYNC_RC=0
SYNC_SUMMARY="$(node scripts/setup-staging-lib.mjs sync-github)" || SYNC_RC=$?
echo "  GitHub sync summary: ${SYNC_SUMMARY}"

# Step 8: Materialize staging Wrangler config with R2 binding
echo "[8/10] Materializing staging Wrangler configuration and R2 binding..."
STAGING_WRANGLER_TOML="$TEMP_DIR/wrangler-v3-read-staging.toml"
AIRINGCAL_STAGING_PUBLIC_R2_BUCKET="$RESOLVED_PUBLIC_BUCKET" \
AIRINGCAL_STAGING_PUBLIC_BASE_URL="$RESOLVED_PUBLIC_URL" \
BANGUMI_GIT_COMMIT_SHA="$GIT_SHA" \
  node scripts/materialize-v3-read-staging-config.mjs \
    apps/v3-read-worker/wrangler.toml \
    "$STAGING_WRANGLER_TOML"

# Step 9: Deploy Staging Read Worker with `--env-file /dev/null` so `.env` is never uploaded
WORKER_URL=""
if [[ "$SKIP_DEPLOY" -eq 0 ]]; then
  echo "[9/10] Deploying Staging Read Worker (${WORKER_NAME})..."
  DEPLOY_OUT="$(pnpm exec wrangler --env-file /dev/null deploy --config "$STAGING_WRANGLER_TOML" --name "$WORKER_NAME" 2>&1)"
  WORKER_URL="$(printf '%s
' "$DEPLOY_OUT" | grep -Eo 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' | head -n 1 || true)"
  echo "  Deployed worker: ${WORKER_NAME} (${WORKER_URL:-url-not-parsed})"
else
  echo "[9/10] Skipped Worker deployment (--skip-deploy)."
fi

# Step 10: Verify Buckets, Binding, HTTPS URL and Worker health
echo "[10/10] Verifying staging buckets, HTTPS URL and Worker health..."
pnpm exec wrangler --env-file /dev/null r2 bucket info "$CHECKPOINT_BUCKET" --json >/dev/null
pnpm exec wrangler --env-file /dev/null r2 bucket info "$PUBLIC_BUCKET" --json >/dev/null
PUBLIC_HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${RESOLVED_PUBLIC_URL}/public/current-release.json" || echo "000")"
if [[ "$PUBLIC_HTTP_CODE" != "200" && "$PUBLIC_HTTP_CODE" != "404" ]]; then
  echo "Public HTTPS URL probe failed with unexpected status=${PUBLIC_HTTP_CODE}" >&2
  exit 1
fi

WORKER_VERSION_CODE="skipped"
WORKER_HEALTH_STATE="skipped"
if [[ -n "$WORKER_URL" ]]; then
  WORKER_VERSION_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${WORKER_URL}/api/version" || echo "000")"
  if [[ "$WORKER_VERSION_CODE" != "200" ]]; then
    echo "Staging Worker /api/version verification failed (status=${WORKER_VERSION_CODE})" >&2
    exit 1
  fi
  HEALTH_BODY_FILE="$TEMP_DIR/worker-health.json"
  WORKER_HEALTH_CODE="$(curl -sS -o "$HEALTH_BODY_FILE" -w '%{http_code}' "${WORKER_URL}/api/health" || echo "000")"
  WORKER_HEALTH_VERDICT="$(node scripts/setup-staging-lib.mjs classify-health "$WORKER_HEALTH_CODE" < "$HEALTH_BODY_FILE")"
  WORKER_HEALTH_STATE="$(printf '%s' "$WORKER_HEALTH_VERDICT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).state))')"
  if [[ "$WORKER_HEALTH_STATE" == "uninitialized_no_release" ]]; then
    echo "  Note: Worker & R2 binding deployed, but no Release is published yet (HTTP 503 NO_RELEASE). Reader acceptance is NOT yet PASS until Generation 1 is published."
  fi
fi

if [[ "$SYNC_RC" -ne 0 ]]; then
  echo "Staging infrastructure ready, but required GitHub Secret(s) are still missing (exit=${SYNC_RC})." >&2
  exit "$SYNC_RC"
fi

echo "Staging setup complete: environment=${ENV_NAME}, checkpoint=${CHECKPOINT_BUCKET} (private=true), public=${RESOLVED_PUBLIC_BUCKET}, public_url_status=${PUBLIC_HTTP_CODE}, worker=${WORKER_NAME}, version_status=${WORKER_VERSION_CODE}, health_state=${WORKER_HEALTH_STATE}"
