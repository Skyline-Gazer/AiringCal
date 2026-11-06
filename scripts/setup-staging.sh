#!/usr/bin/env bash
# Idempotent one-shot Staging initialization & Read Worker deployment (#147).
#
# Automates:
#  1. Wrangler & GitHub CLI auth/permission checks (Skyline-Gazer/AiringCal only).
#  2. Create or reuse R2 buckets `airingcal-staging-checkpoint` & `airingcal-staging-public`.
#  3. Keep Checkpoint bucket private; enable HTTPS (`r2.dev`) access on Public bucket.
#  4. Configure Cloudflare Read Worker R2 binding (`AIRINGCAL_PUBLIC_R2`).
#  5. Create or reuse GitHub `staging` Environment.
#  6. Populate GitHub `staging` Variables (auto-generating `USERS_JSON` & infra vars).
#  7. Populate GitHub `staging` Secrets via stdin (`gh secret set --env staging`).
#  8. Materialize staging Wrangler config (`scripts/materialize-v3-read-staging-config.mjs`).
#  9. Deploy Staging Read Worker (`airing-cal-v3-read-staging`).
# 10. Verify buckets, binding, HTTPS URL and Worker `/api/version` + `/api/health`.
#
# Never logs secret values, never empties buckets, never touches production resources.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="/usr/local/bin:${PATH:-}"

DRY_RUN=0
SKIP_DEPLOY=0

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-staging.sh [options]

Options:
  --dry-run                   Validate inputs, derive config, and materialize staging
                              Wrangler config without calling remote Cloudflare/GitHub APIs.
  --skip-deploy               Complete bucket/GitHub Environment setup without deploying Worker.
  --primary-user-id <id>      Set AIRINGCAL_STAGING_PRIMARY_USER_ID.
  --username <name>           Optional Bangumi username for auto-generated USERS_JSON.
  --users-json <json>         Explicit AIRINGCAL_STAGING_USERS_JSON override.
  --public-base-url <url>     Explicit AIRINGCAL_STAGING_PUBLIC_BASE_URL override.
  --account-id <hex32>        Explicit AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID override.
  -h, --help                  Show this help message.

Required inputs (at most 3 Secrets + 1-2 business Variables):
  Secrets:
    AIRINGCAL_STAGING_BANGUMI_TOKEN       Bangumi API token (or fallback BGM_TOKEN)
    AIRINGCAL_STAGING_S3_ACCESS_KEY_ID    R2 S3 Access Key ID (scoped to the 2 staging buckets)
    AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY R2 S3 Secret Access Key
  Variables:
    AIRINGCAL_STAGING_PRIMARY_USER_ID     Default Bangumi user ID
    AIRINGCAL_STAGING_USERS_JSON          Optional; auto-generated from PRIMARY_USER_ID when omitted
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

REPO="${AIRINGCAL_REPOSITORY:-Skyline-Gazer/AiringCal}"
ENV_NAME="${AIRINGCAL_TARGET_ENVIRONMENT:-staging}"
CHECKPOINT_BUCKET="${AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET:-airingcal-staging-checkpoint}"
PUBLIC_BUCKET="${AIRINGCAL_STAGING_PUBLIC_R2_BUCKET:-airingcal-staging-public}"
WORKER_NAME="${AIRINGCAL_STAGING_WORKER_NAME:-airing-cal-v3-read-staging}"

if [[ "$REPO" != "Skyline-Gazer/AiringCal" ]]; then
  echo "Cross-repository guard: refusing to operate on $REPO" >&2
  exit 1
fi
if [[ "$ENV_NAME" != "staging" ]]; then
  echo "Cross-environment guard: refusing to operate on environment $ENV_NAME" >&2
  exit 1
fi

# Prefer staging Cloudflare token if provided, else reuse CLOUDFLARE_API_TOKEN
if [[ -n "${AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN:-}" && -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  export CLOUDFLARE_API_TOKEN="$AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN"
fi

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
  export AIRINGCAL_STAGING_USERS_JSON="$(node scripts/setup-staging-lib.mjs build-users-json)"
  export AIRINGCAL_STAGING_PUBLIC_R2_BUCKET="$PUBLIC_BUCKET"
  export BANGUMI_GIT_COMMIT_SHA="$GIT_SHA"
  node scripts/materialize-v3-read-staging-config.mjs \
    apps/v3-read-worker/wrangler.toml \
    "$TEMP_DIR/wrangler-v3-read-staging.toml" >/dev/null
  printf '%s
' "$DERIVED_JSON"
  exit 0
fi

# Step 1: Verify GitHub CLI & Wrangler authentication and permissions
echo "[1/10] Checking GitHub CLI and Wrangler authentication..."
gh auth status >/dev/null
REPO_CHECK="$(gh api "repos/${REPO}" --jq '.full_name')"
if [[ "$REPO_CHECK" != "$REPO" ]]; then
  echo "GitHub CLI cannot access ${REPO}" >&2
  exit 1
fi

WHOAMI_JSON="$(pnpm exec wrangler whoami --json)"
if [[ -z "${AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    export AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
  else
    export AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID="$(printf '%s' "$WHOAMI_JSON" | node scripts/setup-staging-lib.mjs parse-whoami)"
  fi
fi
export CLOUDFLARE_ACCOUNT_ID="$AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID"

# Verify actual R2 permission before mutating anything
pnpm exec wrangler r2 bucket list >/dev/null

# Step 2: Create or reuse staging R2 buckets (idempotent; never empties existing buckets)
echo "[2/10] Ensuring isolated staging R2 buckets (${CHECKPOINT_BUCKET}, ${PUBLIC_BUCKET})..."
for bucket in "$CHECKPOINT_BUCKET" "$PUBLIC_BUCKET"; do
  case "$bucket" in
    airing-cal-public|airing-cal-images|airing-cal-data|airing-cal-checkpoint)
      echo "Refusing to touch production bucket: $bucket" >&2
      exit 1
      ;;
  esac
  if pnpm exec wrangler r2 bucket info "$bucket" --json >/dev/null 2>&1; then
    echo "  Reused existing R2 bucket: $bucket"
  else
    pnpm exec wrangler r2 bucket create "$bucket" >/dev/null
    echo "  Created R2 bucket: $bucket"
  fi
done

# Step 3: Keep Checkpoint private; enable HTTPS access on Public bucket
echo "[3/10] Enforcing private checkpoint bucket and enabling public HTTPS r2.dev URL..."
pnpm exec wrangler r2 bucket dev-url disable "$CHECKPOINT_BUCKET" -y >/dev/null 2>&1 || true
pnpm exec wrangler r2 bucket dev-url enable "$PUBLIC_BUCKET" -y >/dev/null
DEV_URL_OUT="$(pnpm exec wrangler r2 bucket dev-url get "$PUBLIC_BUCKET")"
if [[ -z "${AIRINGCAL_STAGING_PUBLIC_BASE_URL:-}" ]]; then
  export AIRINGCAL_STAGING_PUBLIC_BASE_URL="$(printf '%s' "$DEV_URL_OUT" | node scripts/setup-staging-lib.mjs parse-dev-url)"
fi

# Validate and derive all non-sensitive variables
DERIVED_JSON="$(node scripts/setup-staging-lib.mjs derive)"
export AIRINGCAL_STAGING_USERS_JSON="$(node scripts/setup-staging-lib.mjs build-users-json)"
export AIRINGCAL_STAGING_S3_ENDPOINT="${AIRINGCAL_STAGING_S3_ENDPOINT:-https://${AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com}"
export AIRINGCAL_STAGING_S3_REGION="${AIRINGCAL_STAGING_S3_REGION:-auto}"
export AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET="$CHECKPOINT_BUCKET"
export AIRINGCAL_STAGING_PUBLIC_R2_BUCKET="$PUBLIC_BUCKET"
export AIRINGCAL_STAGING_WORKER_NAME="$WORKER_NAME"

# Step 4 & Step 8: Materialize Wrangler staging config with R2 binding
echo "[4/10] Materializing staging Wrangler configuration and R2 binding..."
export BANGUMI_GIT_COMMIT_SHA="$GIT_SHA"
STAGING_WRANGLER_TOML="$TEMP_DIR/wrangler-v3-read-staging.toml"
node scripts/materialize-v3-read-staging-config.mjs \
  apps/v3-read-worker/wrangler.toml \
  "$STAGING_WRANGLER_TOML"

# Step 5: Create or reuse GitHub `staging` Environment
echo "[5/10] Ensuring GitHub '${ENV_NAME}' Environment on ${REPO}..."
gh api --method PUT "repos/${REPO}/environments/${ENV_NAME}" >/dev/null

# Step 6: Write GitHub Variables to `staging` Environment
echo "[6/10] Writing non-sensitive Variables to GitHub '${ENV_NAME}' Environment..."
for var_name in \
  AIRINGCAL_STAGING_PRIMARY_USER_ID \
  AIRINGCAL_STAGING_USERS_JSON \
  AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID \
  AIRINGCAL_STAGING_PUBLIC_BASE_URL \
  AIRINGCAL_STAGING_PUBLIC_R2_BUCKET \
  AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET \
  AIRINGCAL_STAGING_S3_ENDPOINT \
  AIRINGCAL_STAGING_S3_REGION \
  AIRINGCAL_STAGING_WORKER_NAME
do
  gh variable set "$var_name" --env "$ENV_NAME" --repo "$REPO" --body "${!var_name}"
done

# Step 7: Write GitHub Secrets to `staging` Environment via stdin (never print values)
echo "[7/10] Configuring Secrets in GitHub '${ENV_NAME}' Environment..."
if [[ -z "${AIRINGCAL_STAGING_BANGUMI_TOKEN:-}" && -n "${BGM_TOKEN:-}" ]]; then
  export AIRINGCAL_STAGING_BANGUMI_TOKEN="$BGM_TOKEN"
fi

EXISTING_SECRETS="$(gh secret list --env "$ENV_NAME" --repo "$REPO" --json name --jq '.[].name' 2>/dev/null || true)"
MISSING_SECRETS=()

for secret_name in \
  AIRINGCAL_STAGING_BANGUMI_TOKEN \
  AIRINGCAL_STAGING_S3_ACCESS_KEY_ID \
  AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY
do
  if [[ -n "${!secret_name:-}" ]]; then
    printf '%s' "${!secret_name}" | gh secret set "$secret_name" --env "$ENV_NAME" --repo "$REPO"
    echo "  Set secret: $secret_name"
  elif printf '%s
' "$EXISTING_SECRETS" | grep -Fxq "$secret_name"; then
    echo "  Reused existing secret in GitHub '${ENV_NAME}': $secret_name"
  else
    MISSING_SECRETS+=("$secret_name")
  fi
done

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  printf '%s' "$CLOUDFLARE_API_TOKEN" | gh secret set AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN --env "$ENV_NAME" --repo "$REPO"
  echo "  Set optional GHA deploy secret: AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN"
fi

# Step 8 & 9: Deploy Staging Read Worker
WORKER_URL=""
if [[ "$SKIP_DEPLOY" -eq 0 ]]; then
  echo "[8-9/10] Deploying Staging Read Worker (${WORKER_NAME})..."
  DEPLOY_OUT="$(pnpm exec wrangler deploy --config "$STAGING_WRANGLER_TOML" --name "$WORKER_NAME" 2>&1)"
  WORKER_URL="$(printf '%s
' "$DEPLOY_OUT" | grep -Eo 'https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' | head -n 1 || true)"
  echo "  Deployed worker: ${WORKER_NAME} (${WORKER_URL:-url-not-parsed})"
else
  echo "[8-9/10] Skipped Worker deployment (--skip-deploy)."
fi

# Step 10: Verify Buckets, Binding, HTTPS URL and Worker health
echo "[10/10] Verifying staging buckets, HTTPS URL and Worker health..."
pnpm exec wrangler r2 bucket info "$CHECKPOINT_BUCKET" --json >/dev/null
pnpm exec wrangler r2 bucket info "$PUBLIC_BUCKET" --json >/dev/null
PUBLIC_HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${AIRINGCAL_STAGING_PUBLIC_BASE_URL}/public/current-release.json" || echo "000")"

WORKER_VERSION_CODE="skipped"
WORKER_HEALTH_CODE="skipped"
if [[ -n "$WORKER_URL" ]]; then
  WORKER_VERSION_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${WORKER_URL}/api/version" || echo "000")"
  WORKER_HEALTH_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${WORKER_URL}/api/health" || echo "000")"
  if [[ "$WORKER_VERSION_CODE" != "200" ]]; then
    echo "Staging Worker /api/version verification failed (status=${WORKER_VERSION_CODE})" >&2
    exit 1
  fi
  if [[ "$WORKER_HEALTH_CODE" != "200" && "$WORKER_HEALTH_CODE" != "503" ]]; then
    echo "Staging Worker /api/health returned unexpected status=${WORKER_HEALTH_CODE}" >&2
    exit 1
  fi
fi

if [[ "${#MISSING_SECRETS[@]}" -gt 0 ]]; then
  echo "Staging infrastructure ready; still awaiting Secret(s): ${MISSING_SECRETS[*]}" >&2
  exit 2
fi

echo "Staging setup complete: environment=${ENV_NAME}, checkpoint=${CHECKPOINT_BUCKET}, public=${PUBLIC_BUCKET}, public_url_status=${PUBLIC_HTTP_CODE}, worker=${WORKER_NAME}, version_status=${WORKER_VERSION_CODE}, health_status=${WORKER_HEALTH_CODE}"
