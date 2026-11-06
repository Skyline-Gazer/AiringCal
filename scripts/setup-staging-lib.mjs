/**
 * Pure configuration, validation, derivation and redaction helpers for
 * `scripts/setup-staging.sh` (#147).
 *
 * Naming contract: `AIRINGCAL_{ENVIRONMENT}_{SERVICE}_{KEY}`
 *
 * Staging requires at most:
 * - 3 Secrets:
 *   - `AIRINGCAL_STAGING_BANGUMI_TOKEN`
 *   - `AIRINGCAL_STAGING_S3_ACCESS_KEY_ID`
 *   - `AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY`
 * - 2 Business Variables (`USERS_JSON` auto-generated from `PRIMARY_USER_ID` if omitted):
 *   - `AIRINGCAL_STAGING_PRIMARY_USER_ID`
 *   - `AIRINGCAL_STAGING_USERS_JSON`
 *
 * Non-sensitive infrastructure values (Account ID, S3 Endpoint, Region,
 * Checkpoint/Public Bucket names, Worker name, Public HTTPS URL) are derived
 * automatically and stored as GitHub Variables, never as Secrets.
 */
import { pathToFileURL } from 'node:url'

export const ALLOWED_REPOSITORY = 'Skyline-Gazer/AiringCal'
export const ALLOWED_ENVIRONMENT = 'staging'

export const STAGING_DEFAULTS = Object.freeze({
  repository: ALLOWED_REPOSITORY,
  environment: ALLOWED_ENVIRONMENT,
  checkpointBucket: 'airingcal-staging-checkpoint',
  publicBucket: 'airingcal-staging-public',
  s3Region: 'auto',
  workerName: 'airing-cal-v3-read-staging',
})

export const FORBIDDEN_PRODUCTION_BUCKETS = Object.freeze([
  'airing-cal-public',
  'airing-cal-images',
  'airing-cal-data',
  'airing-cal-checkpoint',
])

export const FORBIDDEN_PRODUCTION_WORKERS = Object.freeze([
  'airing-cal-frontend',
])

export const STAGING_SECRET_KEYS = Object.freeze([
  'AIRINGCAL_STAGING_BANGUMI_TOKEN',
  'AIRINGCAL_STAGING_S3_ACCESS_KEY_ID',
  'AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY',
])

export const STAGING_VARIABLE_KEYS = Object.freeze([
  'AIRINGCAL_STAGING_PRIMARY_USER_ID',
  'AIRINGCAL_STAGING_USERS_JSON',
  'AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID',
  'AIRINGCAL_STAGING_PUBLIC_BASE_URL',
  'AIRINGCAL_STAGING_PUBLIC_R2_BUCKET',
  'AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET',
  'AIRINGCAL_STAGING_S3_ENDPOINT',
  'AIRINGCAL_STAGING_S3_REGION',
  'AIRINGCAL_STAGING_WORKER_NAME',
])

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i

/**
 * Generates or validates `AIRINGCAL_STAGING_USERS_JSON` from `primaryUserId`
 * (and optional `username`, defaulting to `primaryUserId`).
 */
export function buildUsersJson({ usersJson, primaryUserId, username } = {}) {
  const id = (primaryUserId ?? '').trim()
  if (!id) {
    throw new Error('AIRINGCAL_STAGING_PRIMARY_USER_ID is required')
  }
  const raw = (usersJson ?? '').trim()
  if (!raw) {
    const resolvedUsername = (username ?? '').trim() || id
    return JSON.stringify([{ userId: id, username: resolvedUsername }])
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AIRINGCAL_STAGING_USERS_JSON must be valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('AIRINGCAL_STAGING_USERS_JSON must be a non-empty JSON array')
  }
  const normalized = parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('AIRINGCAL_STAGING_USERS_JSON entries must be objects')
    }
    const userId =
      typeof entry.userId === 'string'
        ? entry.userId.trim()
        : typeof entry.user_id === 'string'
          ? entry.user_id.trim()
          : typeof entry.id === 'string'
            ? entry.id.trim()
            : ''
    const uname = typeof entry.username === 'string' ? entry.username.trim() : userId
    if (!userId || !uname) {
      throw new Error('AIRINGCAL_STAGING_USERS_JSON entries require userId and username')
    }
    return { userId, username: uname }
  })
  if (!normalized.some((u) => u.userId === id)) {
    throw new Error(
      `AIRINGCAL_STAGING_USERS_JSON must contain an entry matching AIRINGCAL_STAGING_PRIMARY_USER_ID (${id})`,
    )
  }
  return JSON.stringify(normalized)
}

export function validateStagingPublicBaseUrl(rawUrl) {
  const trimmed = (rawUrl ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('AIRINGCAL_STAGING_PUBLIC_BASE_URL is required')
  }
  if (/placeholder/i.test(trimmed)) {
    throw new Error('AIRINGCAL_STAGING_PUBLIC_BASE_URL must not be a placeholder value')
  }
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('AIRINGCAL_STAGING_PUBLIC_BASE_URL must be an absolute https URL')
  }
  if (parsed.protocol !== 'https:' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      'AIRINGCAL_STAGING_PUBLIC_BASE_URL must be an absolute https URL without query or fragment',
    )
  }
  return trimmed
}

/**
 * Validates and derives the full non-sensitive Staging configuration + secret presence
 * summary (never includes raw secret values in the returned `variables` or `summary`).
 */
export function deriveStagingConfig(env = process.env) {
  const repository = (env.AIRINGCAL_REPOSITORY ?? STAGING_DEFAULTS.repository).trim()
  if (repository !== ALLOWED_REPOSITORY) {
    throw new Error(
      `Cross-repository guard: setup-staging only operates on ${ALLOWED_REPOSITORY} (got "${repository}")`,
    )
  }

  const environment = (env.AIRINGCAL_TARGET_ENVIRONMENT ?? STAGING_DEFAULTS.environment).trim()
  if (environment !== ALLOWED_ENVIRONMENT) {
    throw new Error(
      `Cross-environment guard: setup-staging only operates on environment "${ALLOWED_ENVIRONMENT}" (got "${environment}")`,
    )
  }

  const checkpointBucket = (
    env.AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET ?? STAGING_DEFAULTS.checkpointBucket
  ).trim()
  const publicBucket = (
    env.AIRINGCAL_STAGING_PUBLIC_R2_BUCKET ?? STAGING_DEFAULTS.publicBucket
  ).trim()

  for (const [label, bucket] of [
    ['AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET', checkpointBucket],
    ['AIRINGCAL_STAGING_PUBLIC_R2_BUCKET', publicBucket],
  ]) {
    if (!BUCKET_NAME_RE.test(bucket)) {
      throw new Error(`${label} must be a valid R2 bucket name (3-63 lowercase chars, got "${bucket}")`)
    }
    if (FORBIDDEN_PRODUCTION_BUCKETS.includes(bucket)) {
      throw new Error(
        `Cross-environment guard: ${label} must never use production bucket "${bucket}"`,
      )
    }
  }
  if (checkpointBucket === publicBucket) {
    throw new Error('Staging checkpoint bucket and public bucket must be distinct')
  }

  const workerName = (env.AIRINGCAL_STAGING_WORKER_NAME ?? STAGING_DEFAULTS.workerName).trim()
  if (!WORKER_NAME_RE.test(workerName)) {
    throw new Error(`AIRINGCAL_STAGING_WORKER_NAME must be a valid lowercase Worker name (got "${workerName}")`)
  }
  if (FORBIDDEN_PRODUCTION_WORKERS.includes(workerName)) {
    throw new Error(
      `Cross-environment guard: AIRINGCAL_STAGING_WORKER_NAME must never overwrite production worker "${workerName}"`,
    )
  }

  const accountId = (
    env.AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID ??
    env.CLOUDFLARE_ACCOUNT_ID ??
    ''
  )
    .trim()
    .toLowerCase()
  if (!ACCOUNT_ID_RE.test(accountId)) {
    throw new Error(
      'AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID) must be a 32-character hex Cloudflare account id',
    )
  }

  const s3Endpoint = (
    env.AIRINGCAL_STAGING_S3_ENDPOINT?.trim() ||
    `https://${accountId}.r2.cloudflarestorage.com`
  ).replace(/\/+$/, '')
  let parsedEndpoint
  try {
    parsedEndpoint = new URL(s3Endpoint)
  } catch {
    throw new Error('AIRINGCAL_STAGING_S3_ENDPOINT must be a valid URL')
  }
  if (parsedEndpoint.protocol !== 'https:') {
    throw new Error('AIRINGCAL_STAGING_S3_ENDPOINT must use https://')
  }

  const s3Region = (env.AIRINGCAL_STAGING_S3_REGION ?? STAGING_DEFAULTS.s3Region).trim() || 'auto'

  const primaryUserId = (env.AIRINGCAL_STAGING_PRIMARY_USER_ID ?? '').trim()
  const usersJson = buildUsersJson({
    usersJson: env.AIRINGCAL_STAGING_USERS_JSON,
    primaryUserId,
    username: env.AIRINGCAL_STAGING_BANGUMI_USERNAME,
  })

  const publicBaseUrl = validateStagingPublicBaseUrl(env.AIRINGCAL_STAGING_PUBLIC_BASE_URL)

  const bangumiToken = (env.AIRINGCAL_STAGING_BANGUMI_TOKEN ?? env.BGM_TOKEN ?? '').trim()
  const s3AccessKeyId = (env.AIRINGCAL_STAGING_S3_ACCESS_KEY_ID ?? '').trim()
  const s3SecretAccessKey = (env.AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY ?? '').trim()
  const cloudflareApiToken = (
    env.AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN ??
    env.CLOUDFLARE_API_TOKEN ??
    ''
  ).trim()

  const variables = {
    AIRINGCAL_STAGING_PRIMARY_USER_ID: primaryUserId,
    AIRINGCAL_STAGING_USERS_JSON: usersJson,
    AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID: accountId,
    AIRINGCAL_STAGING_PUBLIC_BASE_URL: publicBaseUrl,
    AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: publicBucket,
    AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET: checkpointBucket,
    AIRINGCAL_STAGING_S3_ENDPOINT: s3Endpoint,
    AIRINGCAL_STAGING_S3_REGION: s3Region,
    AIRINGCAL_STAGING_WORKER_NAME: workerName,
  }

  const secretsConfigured = {
    AIRINGCAL_STAGING_BANGUMI_TOKEN: bangumiToken.length > 0,
    AIRINGCAL_STAGING_S3_ACCESS_KEY_ID: s3AccessKeyId.length > 0,
    AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY: s3SecretAccessKey.length > 0,
  }
  const missingSecrets = Object.entries(secretsConfigured)
    .filter(([, present]) => !present)
    .map(([key]) => key)

  return {
    repository,
    environment,
    variables,
    secretsConfigured,
    optionalCloudflareTokenPresent: cloudflareApiToken.length > 0,
    missingSecrets,
  }
}

/**
 * Extracts the 32-hex Cloudflare Account ID from `wrangler whoami --json` output.
 */
export function parseWranglerWhoamiJson(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('Failed to parse wrangler whoami --json output')
  }
  if (!data || data.loggedIn === false) {
    throw new Error('Wrangler is not authenticated; set CLOUDFLARE_API_TOKEN or run wrangler login')
  }
  const accounts = Array.isArray(data.accounts) ? data.accounts : []
  const firstId = accounts.find((acc) => typeof acc?.id === 'string' && ACCOUNT_ID_RE.test(acc.id))?.id
  if (!firstId) {
    throw new Error('Could not resolve a 32-hex Cloudflare Account ID from wrangler whoami')
  }
  return firstId.toLowerCase()
}

/**
 * Extracts the `https://pub-...r2.dev` URL from `wrangler r2 bucket dev-url get` output.
 */
export function parseWranglerDevUrlOutput(raw) {
  const match = String(raw ?? '').match(/https:\/\/pub-[a-z0-9]+\.r2\.dev/i)
  if (!match) {
    throw new Error('Could not extract https://pub-*.r2.dev URL from wrangler r2 bucket dev-url output')
  }
  return match[0].toLowerCase()
}

/**
 * Redacts known secret values and bearer tokens from any diagnostic string.
 */
export function redactSecrets(text, secretValues = []) {
  let out = String(text ?? '')
  for (const secret of secretValues) {
    const trimmed = typeof secret === 'string' ? secret.trim() : ''
    if (trimmed.length >= 4) {
      out = out.split(trimmed).join('[REDACTED]')
    }
  }
  out = out.replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
  return out
}

async function runCli() {
  const [, , cmd, ...rest] = process.argv
  if (cmd === 'build-users-json') {
    const primaryUserId = rest[0] ?? process.env.AIRINGCAL_STAGING_PRIMARY_USER_ID ?? ''
    const usersJson = rest[1] ?? process.env.AIRINGCAL_STAGING_USERS_JSON ?? ''
    const username = rest[2] ?? process.env.AIRINGCAL_STAGING_BANGUMI_USERNAME ?? ''
    process.stdout.write(buildUsersJson({ usersJson, primaryUserId, username }))
    return
  }
  if (cmd === 'parse-whoami') {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    process.stdout.write(parseWranglerWhoamiJson(Buffer.concat(chunks).toString('utf8')))
    return
  }
  if (cmd === 'parse-dev-url') {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    process.stdout.write(parseWranglerDevUrlOutput(Buffer.concat(chunks).toString('utf8')))
    return
  }
  if (cmd === 'derive') {
    const derived = deriveStagingConfig(process.env)
    process.stdout.write(`${JSON.stringify(derived, null, 2)}\n`)
    return
  }
  console.error('Usage: node scripts/setup-staging-lib.mjs <derive|build-users-json|parse-whoami|parse-dev-url>')
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
