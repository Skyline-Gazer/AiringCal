/**
 * Deploy-env pure helpers for AIRINGCAL_ENV-driven single-bucket cutover.
 *
 * Reuses .env parsing/redaction from setup-staging-lib.mjs. Live mutations live
 * in deploy-env.mjs and stay behind --apply; this module owns plan shape,
 * alias mapping, isolation verdicts, and production refuse rules.
 */
import { loadDotEnvFile, parseDotEnvContent, redactSecrets } from './setup-staging-lib.mjs'
import { MUTATION_STATUSES, createMutationLedger, isAmbiguousTransportError } from './mutation-ledger.mjs'

export { loadDotEnvFile, parseDotEnvContent, redactSecrets, MUTATION_STATUSES, createMutationLedger, isAmbiguousTransportError }

export const ALLOWED_REPOSITORY = 'Skyline-Gazer/AiringCal'

export const DEVELOPMENT_DEFAULTS = Object.freeze({
  repository: ALLOWED_REPOSITORY,
  environment: 'development',
  bucket: 'airingcal-development',
  workerName: 'airingcal-development',
  edgeoneProject: 'airingcal-edgeone-read-overseas',
  edgeoneRegion: 'overseas',
  s3Region: 'auto',
  // R2 AllowedMethods supports GET/PUT/POST/DELETE/HEAD only — OPTIONS is
  // handled by the CORS preflight mechanism itself, never listed here.
  corsMethods: Object.freeze(['GET', 'HEAD']),
  isolationProbeKey: 'checkpoints/_isolation-probe.txt',
  isolationProbeBody: 'isolation-probe',
  localSmokeOrigins: Object.freeze([
    'http://127.0.0.1:8787',
    'http://localhost:8787',
  ]),
  stagingSource: Object.freeze({
    checkpointBucket: 'airingcal-staging-checkpoint',
    publicBucket: 'airingcal-staging-public',
  }),
})
export const PRODUCTION_DEFAULTS = Object.freeze({
  repository: ALLOWED_REPOSITORY,
  environment: 'production',
  bucket: 'airingcal-production',
  workerName: 'airingcal-production',
  edgeoneProject: 'airingcal-edgeone-read-production',
  edgeoneRegion: 'overseas',
  s3Region: 'auto',
  corsMethods: Object.freeze(['GET', 'HEAD']),
  isolationProbeKey: 'checkpoints/_isolation-probe.txt',
  isolationProbeBody: 'isolation-probe',
})

/** Bucket / resource names that must never be used as Production targets. */
export const PRODUCTION_FORBIDDEN_COLLISION_NAMES = Object.freeze([
  'airingcal-development',
  'airingcal-staging-checkpoint',
  'airingcal-staging-public',
  'airing-cal-public',
  'airing-cal-checkpoint',
  'airing-cal-images',
  'airing-cal-data',
  // Live v2 Production worker — must never be overwritten by v3 Production readers.
  'airing-cal-frontend',
  // Legacy non-canonical v3 reader names (#147 era) — never as Production targets.
  'airing-cal-v3-read-staging',
  'airing-cal-v3-read-production',
  // Existing EdgeOne reader project kept as rollback (keepOldProject).
  'airingcal-edgeone-read',
  DEVELOPMENT_DEFAULTS.workerName,
  DEVELOPMENT_DEFAULTS.edgeoneProject,
])



/** @type {Readonly<Record<string, string>>} */
export const STAGING_ALIAS_MAP = Object.freeze({
  AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN: 'AIRINGCAL_CLOUDFLARE_API_TOKEN',
  AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID: 'AIRINGCAL_CLOUDFLARE_ACCOUNT_ID',
  AIRINGCAL_STAGING_BANGUMI_TOKEN: 'AIRINGCAL_BANGUMI_TOKEN',
  AIRINGCAL_STAGING_PRIMARY_USER_ID: 'AIRINGCAL_PRIMARY_USER_ID',
  AIRINGCAL_STAGING_PUBLIC_BASE_URL: 'AIRINGCAL_PUBLIC_BASE_URL',
  AIRINGCAL_STAGING_S3_ACCESS_KEY_ID: 'AIRINGCAL_S3_ACCESS_KEY_ID',
  AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY: 'AIRINGCAL_S3_SECRET_ACCESS_KEY',
})

export const DEVELOPMENT_SECRET_KEYS = Object.freeze([
  'AIRINGCAL_DEVELOPMENT_BANGUMI_TOKEN',
  'AIRINGCAL_DEVELOPMENT_S3_ACCESS_KEY_ID',
  'AIRINGCAL_DEVELOPMENT_S3_SECRET_ACCESS_KEY',
])

export const DEVELOPMENT_VARIABLE_KEYS = Object.freeze([
  'AIRINGCAL_DEVELOPMENT_PRIMARY_USER_ID',
  'AIRINGCAL_DEVELOPMENT_USERS_JSON',
  'AIRINGCAL_DEVELOPMENT_CLOUDFLARE_ACCOUNT_ID',
  'AIRINGCAL_DEVELOPMENT_PUBLIC_BASE_URL',
  'AIRINGCAL_DEVELOPMENT_R2_BUCKET',
  'AIRINGCAL_DEVELOPMENT_S3_ENDPOINT',
  'AIRINGCAL_DEVELOPMENT_S3_REGION',
  'AIRINGCAL_DEVELOPMENT_WORKER_NAME',
  'AIRINGCAL_DEVELOPMENT_WRITER_ENABLED',
])

/** Production variable names exactly as the portable-writer.yml production job reads them. */
export const PRODUCTION_VARIABLE_KEYS = Object.freeze([
  'AIRINGCAL_PRODUCTION_PRIMARY_USER_ID',
  'AIRINGCAL_PRODUCTION_USERS_JSON',
  'AIRINGCAL_PRODUCTION_CLOUDFLARE_ACCOUNT_ID',
  'AIRINGCAL_PRODUCTION_PUBLIC_BASE_URL',
  'AIRINGCAL_PRODUCTION_R2_BUCKET',
  'AIRINGCAL_PRODUCTION_S3_ENDPOINT',
  'AIRINGCAL_PRODUCTION_S3_REGION',
  'AIRINGCAL_PRODUCTION_WORKER_NAME',
  'AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED',
])

/**
 * Steps whose success implies EXTERNAL state may have changed (bucket,
 * GitHub env/vars/secrets, workers, edge config, dispatches). Read-only or
 * plan-only steps (token probe, S3 derive, verification, evaluation) are
 * excluded. Used to answer "what actually mutated?" truthfully in the apply
 * result JSON (ShipReview #10) — `completed` alone conflates probes with
 * mutations.
 */
export const MUTATING_STEP_IDS = Object.freeze([
  'writer-freeze',
  'ensure-bucket',
  'ensure-bucket-empty',
  'probe-residue-delete',
  'provision-writer-credential',
  'disable-r2-dev',
  'attach-custom-domain',
  'cache-rules',
  'cors',
  'waf-checkpoints',
  'isolation-probe-write',
  'isolation-probe-cleanup',
  'copy-public',
  'copy-checkpoints',
  'sync-gh-env',
  'deploy-cloudflare',
  'deploy-edgeone',
  'materialize-and-deploy-readers',
  'bangumi-full-sync-owner-dispatch',
  'single-writer-test',
])

const EXECUTED_LEDGER_STATUSES = new Set([
  'confirmed-success',
  'unknown-outcome',
  'compensation-success',
  'compensation-failed',
])

export function mutationsExecutedFrom(completed, ledgerEntries = []) {
  const executed = []
  const done = Array.isArray(completed) ? completed : []
  for (const id of done) {
    if (MUTATING_STEP_IDS.includes(id) && !executed.includes(id)) {
      executed.push(id)
    }
  }
  const entries = Array.isArray(ledgerEntries) ? ledgerEntries : []
  for (const entry of entries) {
    if (entry && EXECUTED_LEDGER_STATUSES.has(entry.status) && entry.op && !executed.includes(entry.op)) {
      executed.push(entry.op)
    }
  }
  return executed
}

export const PRODUCTION_SECRET_KEYS = Object.freeze([
  'AIRINGCAL_PRODUCTION_BANGUMI_TOKEN',
  'AIRINGCAL_PRODUCTION_S3_ACCESS_KEY_ID',
  'AIRINGCAL_PRODUCTION_S3_SECRET_ACCESS_KEY',
  // Read by the production job (portable-writer.yml) for writer-failure
  // notification; syncGithubEnvironment only writes it when the operator
  // actually set AIRINGCAL_BARK_URL, but the allowlist must admit it or the
  // secret is silently dropped while the workflow still references it.
  'AIRINGCAL_PRODUCTION_BARK_URL',
])

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const ALLOWED_TARGETS = new Set(['cloudflare', 'edgeone', 'both'])
const ALLOWED_ENVS = new Set(['development', 'production'])

/** Methods R2 CORS `AllowedMethods` actually accepts (OPTIONS is NOT one). */
export const R2_CORS_ALLOWED_METHODS = Object.freeze(['GET', 'PUT', 'POST', 'DELETE', 'HEAD'])

/**
 * Validate + normalize a caller-supplied CORS method list for R2.
 * OPTIONS preflight is answered by the CORS mechanism itself; R2 rejects it in
 * AllowedMethods, so supplying it is an explicit configuration error.
 *
 * @param {string[]} [methods]
 * @returns {string[]}
 */
export function normalizeCorsAllowedMethods(methods) {
  const list = Array.isArray(methods) ? methods : [...DEVELOPMENT_DEFAULTS.corsMethods]
  const normalized = []
  for (const raw of list) {
    const method = String(raw ?? '').trim().toUpperCase()
    if (!method) continue
    if (method === 'OPTIONS') {
      throw new Error(
        'R2 CORS AllowedMethods does not support OPTIONS (preflight is handled by the CORS mechanism itself); valid methods: GET, PUT, POST, DELETE, HEAD',
      )
    }
    if (!R2_CORS_ALLOWED_METHODS.includes(method)) {
      throw new Error(
        `R2 CORS AllowedMethods unsupported: ${method}; valid methods: GET, PUT, POST, DELETE, HEAD`,
      )
    }
    if (!normalized.includes(method)) normalized.push(method)
  }
  if (normalized.length === 0) {
    throw new Error(
      'R2 CORS AllowedMethods empty — refusing to apply a CORS config without methods (valid: GET, PUT, POST, DELETE, HEAD)',
    )
  }
  return normalized
}

const PRODUCTION_DOTENV_BASENAME = '.env.production'

/**
 * Resolve which dotenv file deploy-env loads.
 * Production MUST use an explicit AIRINGCAL_DOTENV_PATH whose basename is
 * `.env.production` — never the Development root `.env` default.
 *
 * @param {{ envName: string, dotenvPathEnv?: string|null }} opts
 * @returns {string}
 */
export function resolveDeployDotenvPath({ envName, dotenvPathEnv = process.env.AIRINGCAL_DOTENV_PATH } = {}) {
  const name = String(envName ?? '').trim().toLowerCase()
  const configured = String(dotenvPathEnv ?? '').trim()
  if (name === 'production') {
    if (!configured) {
      throw new Error(
        'Production requires AIRINGCAL_DOTENV_PATH pointing at .env.production (refusing default .env)',
      )
    }
    const base = configured.split(/[\\/]/).pop()
    if (base !== PRODUCTION_DOTENV_BASENAME) {
      throw new Error(
        `Production AIRINGCAL_DOTENV_PATH must end with ${PRODUCTION_DOTENV_BASENAME} (got "${configured}")`,
      )
    }
    return configured
  }
  return configured || '.env'
}

/**
 * Refuse Production runs that still carry Development/Staging writable secrets
 * in the process environment (Shell inheritance / mixed configs).
 *
 * @param {Record<string, string | undefined | null>} env
 */
export function assertProductionProcessEnvIsolation(env = {}) {
  const leaked = []
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('AIRINGCAL_STAGING_') && !key.startsWith('AIRINGCAL_DEVELOPMENT_')) continue
    if (String(raw ?? '').trim()) leaked.push(key)
  }
  if (leaked.length > 0) {
    throw new Error(
      `Production must not inherit Development/Staging credentials or config (${leaked.sort().join(', ')}); use an isolated shell with AIRINGCAL_DOTENV_PATH=.env.production only`,
    )
  }
}

/**
 * Load Production env from `.env.production` with file-over-shell precedence
 * (`override: true`) so Development Shell values cannot win.
 *
 * @param {string} dotenvPath
 * @param {Record<string, string | undefined>} [processEnv]
 */
export function loadProductionDeployEnv(dotenvPath, processEnv = process.env) {
  assertProductionProcessEnvIsolation(processEnv)
  const pathBase = String(dotenvPath ?? '').split(/[\\/]/).pop()
  if (pathBase !== PRODUCTION_DOTENV_BASENAME) {
    throw new Error(
      `Production dotenv basename must be ${PRODUCTION_DOTENV_BASENAME} (got "${dotenvPath}")`,
    )
  }
  return loadDotEnvFile(dotenvPath, processEnv, { override: true })
}

/**
 * @param {string[]} argv
 */
export function parseDeployArgs(argv = process.argv) {
  const args = argv.slice(2)
  let dryRun = false
  let apply = false
  let target = 'both'
  let targetExplicit = false
  let forceProduction = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--i-am-sure-production') {
      forceProduction = true
      continue
    }
    if (arg === '--target') {
      const value = args[++i]
      if (!ALLOWED_TARGETS.has(value)) {
        throw new Error(`--target must be cloudflare|edgeone|both (got "${value}")`)
      }
      target = value
      targetExplicit = true
      continue
    }
    if (arg.startsWith('--target=')) {
      const value = arg.slice('--target='.length)
      if (!ALLOWED_TARGETS.has(value)) {
        throw new Error(`--target must be cloudflare|edgeone|both (got "${value}")`)
      }
      target = value
      targetExplicit = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return { dryRun, apply, target, targetExplicit, forceProduction }
}

/**
 * @param {{ envName: string, dryRun: boolean, apply: boolean, forceProduction: boolean }} input
 */
export function resolveExecutionMode({ envName, dryRun, apply, forceProduction }) {
  const name = String(envName ?? '').trim().toLowerCase()
  if (!ALLOWED_ENVS.has(name)) {
    throw new Error(`AIRINGCAL_ENV must be development|production (got "${envName}")`)
  }

  if (dryRun && apply) {
    throw new Error('Pass either --dry-run or --apply, not both')
  }

  if (name === 'production') {
    if (apply) {
      if (!forceProduction) {
        throw new Error(
          'Refusing production --apply without --i-am-sure-production (no mutations performed)',
        )
      }
      return { mode: 'apply', reason: 'production-forced' }
    }
    return { mode: 'dry-run', reason: dryRun ? 'explicit-dry-run' : 'production-default-dry-run' }
  }

  if (apply) return { mode: 'apply', reason: 'explicit-apply' }
  if (dryRun) return { mode: 'dry-run', reason: 'explicit-dry-run' }
  return { mode: 'dry-run', reason: 'development-default-dry-run' }
}

/**
 * Map AIRINGCAL_STAGING_* → new keys when AIRINGCAL_ENV=development and the
 * new key is empty. Emits one-time deprecation warnings (caller prints once).
 *
 * @param {Record<string, string | undefined>} inputEnv
 */
export function applyStagingAliases(inputEnv = {}) {
  const env = { ...inputEnv }
  const warnings = []
  const airingEnv = String(env.AIRINGCAL_ENV ?? '').trim().toLowerCase()
  if (airingEnv !== 'development') {
    return { env, warnings }
  }

  for (const [legacyKey, newKey] of Object.entries(STAGING_ALIAS_MAP)) {
    const legacy = typeof env[legacyKey] === 'string' ? env[legacyKey].trim() : ''
    const current = typeof env[newKey] === 'string' ? env[newKey].trim() : ''
    if (legacy && !current) {
      env[newKey] = legacy
      warnings.push(
        `deprecated: ${legacyKey} mapped to ${newKey}; prefer the new key in .env`,
      )
    }
  }
  return { env, warnings }
}

/** Production required secrets that must not be filled only via staging/development aliases. */
export const PRODUCTION_REQUIRED_SECRET_KEYS = Object.freeze([
  'AIRINGCAL_BANGUMI_TOKEN',
  'AIRINGCAL_CLOUDFLARE_API_TOKEN',
  'AIRINGCAL_EDGEONE_API_TOKEN',
])

/**
 * Refuse Production config when a required Production secret is empty while a
 * corresponding AIRINGCAL_STAGING_* or AIRINGCAL_DEVELOPMENT_* writable secret
 * is present (aliases must never supply Production). Does not call
 * applyStagingAliases.
 *
 * @param {Record<string, string | undefined | null>} env
 */
export function assertNoProductionSecretAliases(env = {}) {
  for (const key of PRODUCTION_REQUIRED_SECRET_KEYS) {
    const present = Boolean(String(env[key] ?? '').trim())
    if (present) continue
    const suffix = key.slice('AIRINGCAL_'.length)
    const stagingKey = `AIRINGCAL_STAGING_${suffix}`
    const developmentKey = `AIRINGCAL_DEVELOPMENT_${suffix}`
    const stagingPresent = Boolean(String(env[stagingKey] ?? '').trim())
    const developmentPresent = Boolean(String(env[developmentKey] ?? '').trim())
    if (!stagingPresent && !developmentPresent) continue
    const source = stagingPresent ? stagingKey : developmentKey
    throw new Error(
      `Production must not alias ${key} from ${source}; set ${key} in .env.production`,
    )
  }
}

/**
 * Assert Production resource names do not collide with Development/Staging/v2 names.
 * @param {{ bucket: string, cloudflareWorkerName: string, edgeoneProject: string }} names
 */
export function assertProductionResourceNames({ bucket, cloudflareWorkerName, edgeoneProject }) {
  const forbidden = new Set(PRODUCTION_FORBIDDEN_COLLISION_NAMES)
  for (const [label, value] of [
    ['bucket', bucket],
    ['cloudflareWorkerName', cloudflareWorkerName],
    ['edgeoneProject', edgeoneProject],
  ]) {
    const name = String(value ?? '').trim()
    if (!name) {
      throw new Error(`Production ${label} is required`)
    }
    if (forbidden.has(name)) {
      throw new Error(
        `Production ${label} "${name}" collides with Development/Staging/v2 forbidden names`,
      )
    }
  }
  if (bucket !== PRODUCTION_DEFAULTS.bucket) {
    throw new Error(
      `Production bucket must be hard-coded ${PRODUCTION_DEFAULTS.bucket} (got "${bucket}")`,
    )
  }
}

/**
 * Build the copy-free Production clean-bootstrap plan.
 *
 * @param {{
 *   target?: 'cloudflare'|'edgeone'|'both',
 *   publicBaseUrl: string,
 *   edgeoneProject?: string,
 *   edgeoneRegion?: string,
 *   cloudflareWorkerName?: string,
 *   imageBaseUrl?: string,
 *   mode?: 'dry-run'|'apply',
 *   accountId?: string,
 *   zoneId?: string,
 *   applyAuthorized?: boolean,
 *   gitSha?: string|null,
 * }} opts
 */
export function buildProductionPlan({
  target = 'both',
  publicBaseUrl,
  edgeoneProject = PRODUCTION_DEFAULTS.edgeoneProject,
  edgeoneRegion = PRODUCTION_DEFAULTS.edgeoneRegion,
  cloudflareWorkerName = PRODUCTION_DEFAULTS.workerName,
  imageBaseUrl = '',
  mode = 'dry-run',
  accountId = '',
  zoneId = '',
  publicOriginMode = '',
  workerCustomDomain = '',
  workersDevSubdomain = 'r7a',
  applyAuthorized = false,
  gitSha = null,
} = {}) {
  if (!ALLOWED_TARGETS.has(target)) {
    throw new Error(`target must be cloudflare|edgeone|both (got "${target}")`)
  }
  const base = String(publicBaseUrl ?? '').trim().replace(/\/+$/, '')

  const bucket = PRODUCTION_DEFAULTS.bucket
  assertProductionResourceNames({
    bucket,
    cloudflareWorkerName,
    edgeoneProject,
  })

  // §6.3 private-R2 target: unset (or Worker-hosted) base = the Worker is the
  // only anonymous surface. A bucket custom domain keeps the legacy edge plan.
  const resolvedOriginMode = resolvePublicOriginMode({
    publicBaseUrl: base,
    cloudflareWorkerName,
    publicOriginMode,
    workerCustomDomain,
  })
  // #195 P1.4: a zone is only needed to touch DNS/edge surfaces — the legacy
  // bucket-domain topology. Worker mode (workers.dev or Worker custom domain
  // route) must not demand a zone for readers that never use one.
  const normalizedZoneId = String(zoneId ?? '').trim()
  if (resolvedOriginMode === 'bucket-domain' && !normalizedZoneId) {
    throw new Error(
      'AIRINGCAL_ZONE_ID is required for legacy bucket-domain production plans (worker mode does not need a zone)',
    )
  }
  const workerOrigin = `https://${cloudflareWorkerName}.${workersDevSubdomain || 'r7a'}.workers.dev`
  const publicHost = base ? new URL(base).host : new URL(workerOrigin).host

  const imageCdn = validateImageCdnConfig({ publicBaseUrl: base, imageBaseUrl })
  const corsOrigins = buildCorsAllowedOrigins({
    cloudflareWorkerHosts: [workerOrigin],
    edgeoneHosts: base && resolvedOriginMode === 'bucket-domain' ? [base] : [],
  })

  const steps = [
    {
      id: 'preflight-identity',
      title:
        'Require AIRINGCAL_ENV=production, independent Production token/resources (same Cloudflare account OK), zone ownership, Git SHA, refuse name collisions',
      mutates: false,
      requireEnv: 'production',
      forbiddenNames: [...PRODUCTION_FORBIDDEN_COLLISION_NAMES],
      gitSha: gitSha || null,
      accountId: accountId || null,
      zoneId: normalizedZoneId,
      publicHost,
    },

    {
      id: 'ensure-bucket-airingcal-production',
      title: `Discover, prove ownership/adoption, and create-or-reuse bucket ${bucket} (clean bootstrap: abort if any object keys already exist)`,
      mutates: true,
      bucket,
      requireEmptyBucket: true,
      requireEmptyPrefixes: null,
    },
    {
      id: 'provision-production-writer',
      title: `Provision or verify independently scoped Production Writer credential for ${bucket}`,
      mutates: true,
      bucket,
    },
    {
      id: 'verify-bucket-empty',
      title: `Verify object-level emptiness on ${bucket} after credential verification (abort if nonempty)`,
      mutates: false,
      bucket,
      requireEmptyBucket: true,
    },
    {
      id: 'disable-r2-dev',
      title: 'Disable r2.dev on production bucket before isolation proof',
      mutates: true,
    },
    {
      id: 'sync-github-production-env',
      title: 'Sync GitHub Environment production Variables/Secrets from .env.production only',
      mutates: true,
      environment: 'production',
      writerEnabled: false,
    },
    {
      id: 'materialize-and-deploy-readers',
      title: target === 'cloudflare'
        ? 'Materialize + deploy the Production Cloudflare Worker (name must differ from Development)'
        : 'Materialize + deploy Production CF Worker and EdgeOne overseas project (names must differ from Development)',
      mutates: true,
      workerName: cloudflareWorkerName,
      edgeoneProject,
      edgeoneRegion,
      target,
    },
    {
      id: 'bangumi-full-sync-owner-dispatch',
      title:
        'Document-only: Owner later runs Writer workflow_dispatch target=production force_mode=full after enabling AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED (schedule stays gated by AIRINGCAL_WRITER_ENABLED)',
      mutates: false,
      documentOnly: true,
      gated: true,
      workflow: 'portable-writer.yml',
      dispatch: { target: 'production', force_mode: 'full' },
      note: 'Prep must not enable AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED or AIRINGCAL_WRITER_ENABLED; first Full Sync must not arm the schedule',
    },
  ]

  // Edge/bucket-domain steps exist only in the legacy public-bucket topology;
  // in worker mode the deployed readers themselves are the anonymous surface
  // and the isolation probe runs against them after deploy (#72 §6.3).
  const edgeSteps = resolvedOriginMode === 'bucket-domain'
    ? [
      {
        id: 'attach-custom-domain',
        title: `Attach custom domain ${publicHost} from AIRINGCAL_PUBLIC_BASE_URL when missing`,
        mutates: true,
      },
      {
        id: 'cache-rules',
        title: 'Apply cache rules (images/snapshots immutable 1y; pointer max-age=0) host-scoped to production',
        mutates: true,
      },
      {
        id: 'cors',
        title: 'Set CORS AllowedOrigins to exact Production reader + local smoke origins',
        mutates: true,
        allowedOrigins: corsOrigins,
        methods: [...PRODUCTION_DEFAULTS.corsMethods],
      },
      {
        id: 'waf-checkpoints',
        title: 'Configure WAF/path deny for checkpoints/* on production public host',
        mutates: true,
      },
    ]
    : []
  const isolationProbeStep = {
    id: 'isolation-probe',
    title: resolvedOriginMode === 'worker'
      ? 'Write checkpoints/_isolation-probe.txt, prove it exists via S3 HEAD, prove every deployed reader origin denies it anonymously (GET/HEAD + encoded variants), then delete it'
      : 'Write non-sensitive checkpoints/_isolation-probe.txt and prove anonymous GET/HEAD denied before writer publish',
    mutates: true,
    probeKey: PRODUCTION_DEFAULTS.isolationProbeKey,
    abortOnFailure: true,
    dualBucketFallback: false,
    probeTargets: resolvedOriginMode === 'worker' ? 'deployed-reader-origins' : 'bucket-domain',
    positiveProof: true,
    cleanupProbe: true,
  }
  if (resolvedOriginMode === 'worker') {
    const docIndex = steps.findIndex((step) => step.id === 'bangumi-full-sync-owner-dispatch')
    steps.splice(docIndex, 0, isolationProbeStep)
  } else {
    const syncIndex = steps.findIndex((step) => step.id === 'sync-github-production-env')
    steps.splice(syncIndex, 0, ...edgeSteps, isolationProbeStep)
  }

  return {
    env: 'production',
    mode,
    target,
    repository: PRODUCTION_DEFAULTS.repository,
    bucket,
    singleBucket: true,
    dualBucketFallback: false,
    abortOnIsolationFailure: true,
    copyFree: true,
    writerEnabled: false,
    productionWriterEnabled: false,
    applyAuthorized: Boolean(applyAuthorized),
    publicBaseUrl: base || null,
    publicHost,
    publicOriginMode: resolvedOriginMode,
    workerOrigin,
    accountId: accountId || null,
    zoneId: normalizedZoneId || null,
    imageCdn,
    cors: {
      allowedOrigins: corsOrigins,
      methods: [...PRODUCTION_DEFAULTS.corsMethods],
    },
    keyLayout: {
      private: ['checkpoints/**'],
      public: ['public/**', 'snapshots/**', 'images/**'],
    },
    cacheRules: {
      immutable: ['images/*', 'snapshots/*'],
      pointerBypass: ['public/current-release.json'],
    },
    edgeone: target === 'cloudflare'
      ? null
      : { project: edgeoneProject, region: edgeoneRegion },
    cloudflareWorkerName,
    forbiddenCollisionNames: [...PRODUCTION_FORBIDDEN_COLLISION_NAMES],
    steps,
    ownerGatedLiveSteps: [
      'preflight-identity',
      'ensure-bucket-airingcal-production',
      'disable-r2-dev / attach-custom-domain / cache / cors / waf-checkpoints',
      'isolation-probe',
      'sync-github-production-env',
      'materialize-and-deploy-readers',
      'bangumi-full-sync-owner-dispatch (Owner later; gate stays disabled in this prep)',
    ],
  }
}

/**
 * Derive the Production config surface used by dry-run / apply planning.
 * Never maps staging/development aliases. Does not call remote APIs.
 *
 * @param {Record<string, string | undefined | null>} rawEnv
 * @param {{ target?: string, mode?: 'dry-run'|'apply', applyAuthorized?: boolean, gitSha?: string|null }} [opts]
 */
export function deriveProductionConfig(rawEnv = {}, opts = {}) {
  const env = { ...rawEnv }
  const airingEnv = String(env.AIRINGCAL_ENV ?? '').trim().toLowerCase()
  if (airingEnv !== 'production') {
    throw new Error(`deriveProductionConfig only supports production (got "${airingEnv || '(empty)'}")`)
  }
  assertNoProductionSecretAliases(env)

  const accountId = String(
    env.AIRINGCAL_CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID ?? '',
  )
    .trim()
    .toLowerCase()
  if (accountId && !ACCOUNT_ID_RE.test(accountId)) {
    throw new Error('AIRINGCAL_CLOUDFLARE_ACCOUNT_ID must be a 32-character hex Cloudflare account id')
  }

  const publicBaseUrl = String(env.AIRINGCAL_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '')
  // Unset is valid §6.3 worker-origin mode; the plan builder resolves the mode.

  const zoneId = String(env.AIRINGCAL_ZONE_ID ?? env.CLOUDFLARE_ZONE_ID ?? '').trim()
  // #195 P1.4: the zone is no longer unconditional — worker-mode Production
  // needs no DNS surface. buildProductionPlan re-validates: bucket-domain
  // plans still refuse without a zone.
  const publicOriginModeOverride = String(env.AIRINGCAL_PUBLIC_ORIGIN_MODE ?? '').trim()
  const workerCustomDomain = String(env.AIRINGCAL_WORKER_CUSTOM_DOMAIN ?? '').trim()
  const workersDevSubdomain = String(env.AIRINGCAL_WORKERS_DEV_SUBDOMAIN ?? 'r7a').trim() || 'r7a'

  const deployTarget =
    String(opts.target ?? env.AIRINGCAL_DEPLOY_TARGET ?? 'both').trim() || 'both'
  if (!ALLOWED_TARGETS.has(deployTarget)) {
    throw new Error(`AIRINGCAL_DEPLOY_TARGET must be cloudflare|edgeone|both (got "${deployTarget}")`)
  }

  const cloudflareWorkerName =
    String(env.AIRINGCAL_PRODUCTION_WORKER_NAME ?? '').trim() || PRODUCTION_DEFAULTS.workerName
  const edgeoneProject =
    String(env.AIRINGCAL_EDGEONE_PROJECT ?? '').trim() || PRODUCTION_DEFAULTS.edgeoneProject
  const edgeoneRegion =
    String(env.AIRINGCAL_EDGEONE_REGION ?? '').trim() || PRODUCTION_DEFAULTS.edgeoneRegion

  const applyAuthorized =
    opts.applyAuthorized === true ||
    String(env.AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED ?? '').trim() === 'yes'

  const plan = buildProductionPlan({
    target: deployTarget,
    publicBaseUrl,
    edgeoneProject,
    edgeoneRegion,
    cloudflareWorkerName,
    imageBaseUrl: env.AIRINGCAL_IMAGE_BASE_URL || '',
    mode: opts.mode || 'dry-run',
    accountId,
    zoneId,
    publicOriginMode: publicOriginModeOverride,
    workerCustomDomain,
    workersDevSubdomain,
    applyAuthorized,
    gitSha: opts.gitSha ?? null,
  })


  const s3Endpoint =
    String(env.AIRINGCAL_S3_ENDPOINT ?? '').trim() ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')

  const secretsPresent = {
    AIRINGCAL_CLOUDFLARE_API_TOKEN: Boolean(
      String(env.AIRINGCAL_CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN ?? '').trim(),
    ),
    AIRINGCAL_BANGUMI_TOKEN: Boolean(String(env.AIRINGCAL_BANGUMI_TOKEN ?? '').trim()),
    AIRINGCAL_S3_ACCESS_KEY_ID: Boolean(String(env.AIRINGCAL_S3_ACCESS_KEY_ID ?? '').trim()),
    AIRINGCAL_S3_SECRET_ACCESS_KEY: Boolean(String(env.AIRINGCAL_S3_SECRET_ACCESS_KEY ?? '').trim()),
    AIRINGCAL_EDGEONE_API_TOKEN: Boolean(String(env.AIRINGCAL_EDGEONE_API_TOKEN ?? '').trim()),
  }

  return {
    bucket: plan.bucket,
    writerEnabled: false,
    applyAuthorized,
    secretsPresent,
    missingCloudflareToken: !secretsPresent.AIRINGCAL_CLOUDFLARE_API_TOKEN,
    s3Endpoint,
    s3Region: String(env.AIRINGCAL_S3_REGION ?? PRODUCTION_DEFAULTS.s3Region).trim() || 'auto',
    primaryUserId: String(env.AIRINGCAL_PRIMARY_USER_ID ?? '').trim() || null,
    plan,
  }
}

/**
 * @param {{ cloudflareWorkerHosts?: string[], edgeoneHosts?: string[], extraOrigins?: string[] }} opts
 */
export function buildCorsAllowedOrigins({
  cloudflareWorkerHosts = [],
  edgeoneHosts = [],
  extraOrigins = [],
} = {}) {
  const origins = []
  const seen = new Set()
  const push = (raw) => {
    const value = String(raw ?? '').trim().replace(/\/+$/, '')
    if (!value) return
    if (value.includes('*')) {
      throw new Error(`CORS AllowedOrigins must be exact origins (no wildcards): ${value}`)
    }
    if (seen.has(value)) return
    seen.add(value)
    origins.push(value)
  }

  for (const host of cloudflareWorkerHosts) push(host)
  for (const host of edgeoneHosts) push(host)
  for (const host of DEVELOPMENT_DEFAULTS.localSmokeOrigins) push(host)
  for (const host of extraOrigins) push(host)
  return origins
}

/**
 * @param {{
 *   target?: 'cloudflare'|'edgeone'|'both',
 *   publicBaseUrl: string,
 *   edgeoneProject?: string,
 *   edgeoneRegion?: string,
 *   cloudflareWorkerName?: string,
 *   imageBaseUrl?: string,
 *   mode?: 'dry-run'|'apply',
 *   accountId?: string,
 * }} opts
 */
export function buildDevelopmentDeployPlan({
  target = 'both',
  publicBaseUrl,
  edgeoneProject = DEVELOPMENT_DEFAULTS.edgeoneProject,
  edgeoneRegion = DEVELOPMENT_DEFAULTS.edgeoneRegion,
  cloudflareWorkerName = DEVELOPMENT_DEFAULTS.workerName,
  imageBaseUrl = '',
  mode = 'dry-run',
  accountId = '',
  publicOriginMode = '',
  workerCustomDomain = '',
  workersDevSubdomain = 'r7a',
} = {}) {
  if (!ALLOWED_TARGETS.has(target)) {
    throw new Error(`target must be cloudflare|edgeone|both (got "${target}")`)
  }
  const base = String(publicBaseUrl ?? '').trim().replace(/\/+$/, '')

  // §6.3 private-R2 target (mirrors buildProductionPlan): unset/Worker base =
  // the Worker is the only anonymous surface; a bucket custom domain keeps
  // the legacy edge plan (custom domain + WAF + bucket CORS + staging copies).
  const resolvedOriginMode = resolvePublicOriginMode({
    publicBaseUrl: base,
    cloudflareWorkerName,
    publicOriginMode,
    workerCustomDomain,
  })
  const workerOrigin = `https://${cloudflareWorkerName}.${workersDevSubdomain || 'r7a'}.workers.dev`
  const publicHost = base ? new URL(base).host : new URL(workerOrigin).host

  const imageCdn = validateImageCdnConfig({ publicBaseUrl: base, imageBaseUrl })
  const corsOrigins = buildCorsAllowedOrigins({
    cloudflareWorkerHosts: [workerOrigin],
    edgeoneHosts: base && resolvedOriginMode === 'bucket-domain' ? [base] : [],
  })

  const steps = [
    {
      id: 'token-probe',
      title: 'Probe Cloudflare token scopes + derive/verify S3 credentials',
      mutates: false,
    },
    {
      id: 'writer-freeze',
      title: 'Freeze staging writer (workflow disable; wait in_progress=0; lease clear)',
      mutates: true,
      lever: 'workflow-disable',
    },
    {
      id: 'ensure-bucket',
      title: `Ensure single bucket ${DEVELOPMENT_DEFAULTS.bucket}`,
      mutates: true,
      bucket: DEVELOPMENT_DEFAULTS.bucket,
    },
    {
      id: 'disable-r2-dev',
      title: 'Disable r2.dev on development bucket before isolation proof',
      mutates: true,
    },
    {
      id: 'sync-gh-env',
      title: 'Sync GitHub Environment development Variables/Secrets (writer stays disabled)',
      mutates: true,
      environment: 'development',
      writerEnabled: false,
    },
  ]

  const edgeSteps = resolvedOriginMode === 'bucket-domain'
    ? [
      {
        id: 'attach-custom-domain',
        title: `Attach custom domain ${publicHost} when missing`,
        mutates: true,
      },
      {
        id: 'cache-rules',
        title: 'Apply cache rules (images/snapshots immutable 1y; pointer max-age=0)',
        mutates: true,
      },
      {
        id: 'cors',
        title: 'Set CORS AllowedOrigins to exact reader + local smoke origins',
        mutates: true,
        allowedOrigins: corsOrigins,
        methods: [...DEVELOPMENT_DEFAULTS.corsMethods],
      },
      {
        id: 'waf-checkpoints',
        title: 'Configure WAF/path deny for checkpoints/* on public entrypoints',
        mutates: true,
      },
    ]
    : []
  const isolationProbeStep = {
    id: 'isolation-probe',
    title: resolvedOriginMode === 'worker'
      ? 'Write checkpoints/_isolation-probe.txt, prove it exists via S3 HEAD, prove every deployed reader origin denies it anonymously (GET/HEAD + encoded variants), then delete it'
      : 'Write non-sensitive checkpoints/_isolation-probe.txt and prove anonymous GET/HEAD denied',
    mutates: true,
    probeKey: DEVELOPMENT_DEFAULTS.isolationProbeKey,
    abortOnFailure: true,
    dualBucketFallback: false,
    probeTargets: resolvedOriginMode === 'worker' ? 'deployed-reader-origins' : 'bucket-domain',
    positiveProof: true,
    cleanupProbe: true,
  }
  // Staging-coupled migration copies belong ONLY to the legacy one-shot
  // bucket-domain cutover (they ran 2026-11-07/08); worker-mode dev applies
  // are pure infrastructure redeployments against the live single bucket.
  const copySteps = resolvedOriginMode === 'bucket-domain'
    ? [
      {
        id: 'copy-public',
        title: 'Copy public/, snapshots/, images/ from staging public bucket',
        mutates: true,
        requiresIsolationPass: true,
        sourceBucket: DEVELOPMENT_DEFAULTS.stagingSource.publicBucket,
      },
      {
        id: 'copy-checkpoints',
        title: 'Copy real checkpoints/** from staging checkpoint bucket',
        mutates: true,
        requiresIsolationPass: true,
        sourceBucket: DEVELOPMENT_DEFAULTS.stagingSource.checkpointBucket,
      },
    ]
    : []

  if (target === 'cloudflare' || target === 'both') {
    steps.push({
      id: 'deploy-cloudflare',
      title: `Materialize + deploy CF reader ${cloudflareWorkerName} at new bucket/base`,
      mutates: true,
      workerName: cloudflareWorkerName,
    })
  }
  if (target === 'edgeone' || target === 'both') {
    steps.push({
      id: 'deploy-edgeone',
      title: `Create/reuse ${edgeoneProject} (region=${edgeoneRegion}) and deploy dist`,
      mutates: true,
      project: edgeoneProject,
      region: edgeoneRegion,
    })
  }

  steps.push({
    id: 'single-writer-test',
    title: 'Owner-gated: one workflow_dispatch target=development after isolation+copy',
    mutates: true,
    requiresIsolationPass: true,
    gated: true,
  })

  if (resolvedOriginMode === 'worker') {
    // The probe needs the DEPLOYED readers as its anonymous targets, so it
    // runs after both deploy steps and before the gated writer test.
    steps.splice(steps.findIndex((step) => step.id === 'single-writer-test'), 0, isolationProbeStep)
  } else {
    const syncIndex = steps.findIndex((step) => step.id === 'sync-gh-env')
    steps.splice(syncIndex, 0, ...edgeSteps, isolationProbeStep, ...copySteps)
  }

  return {
    env: 'development',
    mode,
    target,
    repository: DEVELOPMENT_DEFAULTS.repository,
    bucket: DEVELOPMENT_DEFAULTS.bucket,
    singleBucket: true,
    dualBucketFallback: false,
    abortOnIsolationFailure: true,
    publicBaseUrl: base || null,
    publicHost,
    publicOriginMode: resolvedOriginMode,
    workerOrigin,
    accountId: accountId || null,
    imageCdn,
    cors: {
      allowedOrigins: corsOrigins,
      methods: [...DEVELOPMENT_DEFAULTS.corsMethods],
    },
    keyLayout: {
      private: ['checkpoints/**'],
      public: ['public/**', 'snapshots/**', 'images/**'],
    },
    cacheRules: {
      immutable: ['images/*', 'snapshots/*'],
      pointerBypass: ['public/current-release.json'],
    },
    writerFreeze: {
      lever: 'workflow-disable',
      workflow: 'portable-writer.yml',
      note: 'Do NOT use AIRINGCAL_WRITER_ENABLED (production-only gate)',
      waitInProgressEmpty: true,
      verifyLeaseClear: true,
    },
    developmentWriterEnabled: false,
    productionWriterEnabled: false,
    stagingSources: { ...DEVELOPMENT_DEFAULTS.stagingSource },
    edgeone: target === 'cloudflare'
      ? null
      : { project: edgeoneProject, region: edgeoneRegion, keepOldProject: 'airingcal-edgeone-read' },
    cloudflareWorkerName,
    steps,
    ownerGatedLiveSteps: [
      'token-probe (needs Cloudflare API token)',
      'writer-freeze workflow disable',
      'ensure-bucket / disable-r2-dev / custom domain / WAF / CORS',
      'isolation-probe anonymous GET/HEAD',
      'copy-public / copy-checkpoints',
      'sync-gh-env secrets',
      'deploy-cloudflare / deploy-edgeone',
      'single-writer-test workflow_dispatch',
    ],
  }
}

/**
 * Hard isolation gate: anonymous GET/HEAD of the probe must be 403/404 and
 * r2.dev must be disabled. Failure aborts cutover — never dual-bucket fallback.
 *
 * @param {{
 *   r2DevDisabled: boolean,
 *   probes: Array<{ url: string, method: string, status: number }>,
 * }}
 */
export function evaluateIsolationProbe({ r2DevDisabled, probes = [] }) {
  if (!r2DevDisabled) {
    return {
      ok: false,
      abortCutover: true,
      dualBucketFallback: false,
      reason: 'isolation failed: r2.dev still enabled on development bucket',
      probes,
    }
  }

  const list = Array.isArray(probes) ? probes : []
  if (list.length === 0) {
    return {
      ok: false,
      abortCutover: true,
      dualBucketFallback: false,
      reason: 'isolation failed: empty probes (need anonymous GET and HEAD)',
      probes: list,
    }
  }

  const methods = new Set(
    list.map((probe) => String(probe?.method ?? '').trim().toUpperCase()).filter(Boolean),
  )
  const missingMethods = []
  if (!methods.has('GET')) missingMethods.push('GET')
  if (!methods.has('HEAD')) missingMethods.push('HEAD')
  if (missingMethods.length > 0) {
    return {
      ok: false,
      abortCutover: true,
      dualBucketFallback: false,
      reason: `isolation failed: missing ${missingMethods.join(' and ')} probe(s)`,
      probes: list,
    }
  }
  const failures = []
  for (const probe of list) {
    const status = Number(probe.status)
    // Cloudflare may reject the malformed traversal variant before routing.
    const path = typeof probe.url === 'string' ? URL.parse(probe.url)?.pathname : undefined
    const malformedTraversal = path?.startsWith('/public/..%2f..%2fcheckpoints/') === true
    if (status !== 403 && status !== 404 && !(malformedTraversal && status === 400)) {
      failures.push({
        url: probe.url,
        method: probe.method,
        status,
        expected: malformedTraversal ? '400|403|404' : '403|404',
      })
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      abortCutover: true,
      dualBucketFallback: false,
      reason: `isolation failed: anonymous checkpoint probe did not demonstrate denial (${failures
        .map((f) => `${f.method} ${f.url} -> ${f.status}`)
        .join('; ')})`,
      failures,
      probes: list,
    }
  }

  return {
    ok: true,
    abortCutover: false,
    dualBucketFallback: false,
    reason: 'isolation proven: anonymous GET/HEAD denied and r2.dev disabled',
    probes: list,
  }
}

/**
 * Resolve which surface is the anonymous public origin (#72 private-R2):
 * - `bucket-domain` (legacy): `AIRINGCAL_PUBLIC_BASE_URL` is a bucket custom
 *   domain / CDN in front of the bucket; WAF, cache and CORS live at the edge.
 * - `worker` (target): unset or pointing at the Worker itself; the bucket has
 *   no anonymous surface, the Worker serves the controlled public object
 *   interface, streams images, and answers CORS from its own allowlist.
 */
export function resolvePublicOriginMode({
  publicBaseUrl = '',
  cloudflareWorkerName,
  publicOriginMode = '',
  workerCustomDomain = '',
} = {}) {
  const explicit = String(publicOriginMode ?? '').trim().toLowerCase()
  if (explicit) {
    if (explicit !== 'worker' && explicit !== 'bucket-domain') {
      throw new Error(`AIRINGCAL_PUBLIC_ORIGIN_MODE must be worker|bucket-domain (got "${explicit}")`)
    }
    return explicit
  }
  const base = String(publicBaseUrl).trim().replace(/\/+$/, '')
  if (!base) return 'worker'
  let host
  try {
    host = new URL(base).host
  } catch {
    throw new Error('AIRINGCAL_PUBLIC_BASE_URL must be an absolute URL')
  }
  if (host.endsWith('.workers.dev')) return 'worker'
  const custom = String(workerCustomDomain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
  if (custom && host.toLowerCase() === custom) return 'worker'
  // #195 P1.4: a non-workers.dev public host is NOT automatically the legacy
  // bucket-domain topology — it may be a Worker custom domain. The operator
  // must state which topology this URL belongs to; never silently expose or
  // manage an R2 bucket domain because a URL string looked "external".
  throw new Error(
    `Ambiguous public origin host "${host}": set AIRINGCAL_PUBLIC_ORIGIN_MODE=worker ` +
      `(Worker custom domain / explicit worker surface) or =bucket-domain (legacy public bucket + CDN). ` +
      `Legacy bucket-domain mode is never inferred.`,
  )
}

/**
 * @param {{
 *   publicBaseUrl?: string,
 *   imageBaseUrl?: string,
 *   originHost?: string,
 * }}
 */
export function validateImageCdnConfig({ publicBaseUrl, imageBaseUrl = '', originHost } = {}) {
  const publicRaw = String(publicBaseUrl ?? '').trim()
  const trimmedImage = String(imageBaseUrl ?? '').trim()
  if (!publicRaw) {
    // Worker-origin mode (§6.3): with no public bucket base, `/image/*`
    // streams from the store; an image CDN base would redirect to a raw
    // bucket URL the private architecture does not expose.
    if (trimmedImage) {
      throw new Error(
        'AIRINGCAL_IMAGE_BASE_URL requires AIRINGCAL_PUBLIC_BASE_URL (redirect mode); leave it empty to stream images from the Worker',
      )
    }
    return { enabled: false, imageBaseUrl: null }
  }
  const publicUrl = new URL(publicRaw)
  if (publicUrl.protocol !== 'https:') {
    throw new Error('AIRINGCAL_PUBLIC_BASE_URL must be https')
  }
  if (!trimmedImage) {
    return {
      enabled: false,
      imageBaseUrl: publicUrl.origin + publicUrl.pathname.replace(/\/+$/, ''),
    }
  }

  let imageUrl
  try {
    imageUrl = new URL(trimmedImage)
  } catch {
    throw new Error('AIRINGCAL_IMAGE_BASE_URL must be an absolute URL')
  }
  if (imageUrl.protocol !== 'https:') {
    throw new Error('AIRINGCAL_IMAGE_BASE_URL must be https')
  }
  if (imageUrl.host === publicUrl.host) {
    throw new Error(
      'AIRINGCAL_IMAGE_BASE_URL host must differ from AIRINGCAL_PUBLIC_BASE_URL (rejects same-host loop)',
    )
  }

  const resolvedOrigin =
    typeof originHost === 'string' && originHost.trim()
      ? originHost.trim()
      : publicUrl.host

  return {
    enabled: true,
    imageBaseUrl: imageUrl.origin + imageUrl.pathname.replace(/\/+$/, ''),
    originHost: resolvedOrigin,
  }
}

/**
 * Derive the development config surface used by dry-run / apply planning.
 * Does not call remote APIs.
 *
 * @param {Record<string, string | undefined>} rawEnv
 * @param {{ target?: string, mode?: 'dry-run'|'apply' }} opts
 */
export function deriveDevelopmentConfig(rawEnv = {}, { target, mode = 'dry-run' } = {}) {
  const { env, warnings } = applyStagingAliases(rawEnv)
  const airingEnv = String(env.AIRINGCAL_ENV ?? 'development').trim().toLowerCase()
  if (airingEnv !== 'development') {
    throw new Error(`deriveDevelopmentConfig only supports development (got "${airingEnv}")`)
  }

  const accountId = String(
    env.AIRINGCAL_CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID ?? '',
  )
    .trim()
    .toLowerCase()
  if (accountId && !ACCOUNT_ID_RE.test(accountId)) {
    throw new Error('AIRINGCAL_CLOUDFLARE_ACCOUNT_ID must be a 32-character hex Cloudflare account id')
  }

  const bucket = DEVELOPMENT_DEFAULTS.bucket
  if (!BUCKET_NAME_RE.test(bucket)) {
    throw new Error(`Invalid development bucket name: ${bucket}`)
  }

  const publicBaseUrl = String(env.AIRINGCAL_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '')
  // Unset is valid §6.3 worker-origin mode; the plan builder resolves the mode.

  // Explicit CLI `--target` (passed via opts.target) wins over env.
  const deployTarget = String(target ?? env.AIRINGCAL_DEPLOY_TARGET ?? 'both').trim() || 'both'
  if (!ALLOWED_TARGETS.has(deployTarget)) {
    throw new Error(`AIRINGCAL_DEPLOY_TARGET must be cloudflare|edgeone|both (got "${deployTarget}")`)
  }

  const plan = buildDevelopmentDeployPlan({
    target: deployTarget,
    publicBaseUrl,
    edgeoneProject: env.AIRINGCAL_EDGEONE_PROJECT || DEVELOPMENT_DEFAULTS.edgeoneProject,
    edgeoneRegion: env.AIRINGCAL_EDGEONE_REGION || DEVELOPMENT_DEFAULTS.edgeoneRegion,
    cloudflareWorkerName: env.AIRINGCAL_DEVELOPMENT_WORKER_NAME || DEVELOPMENT_DEFAULTS.workerName,
    imageBaseUrl: env.AIRINGCAL_IMAGE_BASE_URL || '',
    mode,
    accountId,
    publicOriginMode: String(env.AIRINGCAL_PUBLIC_ORIGIN_MODE ?? '').trim(),
    workerCustomDomain: String(env.AIRINGCAL_WORKER_CUSTOM_DOMAIN ?? '').trim(),
    workersDevSubdomain: String(env.AIRINGCAL_WORKERS_DEV_SUBDOMAIN ?? 'r7a').trim() || 'r7a',
  })

  const s3Endpoint =
    String(env.AIRINGCAL_S3_ENDPOINT ?? '').trim() ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')

  const secretsPresent = {
    AIRINGCAL_CLOUDFLARE_API_TOKEN: Boolean(
      String(env.AIRINGCAL_CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN ?? '').trim(),
    ),
    AIRINGCAL_BANGUMI_TOKEN: Boolean(String(env.AIRINGCAL_BANGUMI_TOKEN ?? '').trim()),
    AIRINGCAL_S3_ACCESS_KEY_ID: Boolean(String(env.AIRINGCAL_S3_ACCESS_KEY_ID ?? '').trim()),
    AIRINGCAL_S3_SECRET_ACCESS_KEY: Boolean(String(env.AIRINGCAL_S3_SECRET_ACCESS_KEY ?? '').trim()),
    AIRINGCAL_EDGEONE_API_TOKEN: Boolean(String(env.AIRINGCAL_EDGEONE_API_TOKEN ?? '').trim()),
  }

  return {
    warnings,
    secretsPresent,
    missingCloudflareToken: !secretsPresent.AIRINGCAL_CLOUDFLARE_API_TOKEN,
    s3Endpoint,
    s3Region: String(env.AIRINGCAL_S3_REGION ?? DEVELOPMENT_DEFAULTS.s3Region).trim() || 'auto',
    primaryUserId: String(env.AIRINGCAL_PRIMARY_USER_ID ?? '').trim() || null,
    plan,
  }
}

export function missingScopeExitMessage(missingScopes = []) {
  const list = missingScopes.length > 0 ? missingScopes.join(', ') : 'unknown'
  return `Cloudflare token missing required scopes: ${list} (exit 2)`
}

/**
 * @typedef {object} DevelopmentApplyIo
 * @property {(ctx: object) => Promise<{ ok: boolean, missingScopes?: string[] }>} probeToken
 * @property {(ctx: object) => Promise<object>} deriveAndVerifyS3
 * @property {(ctx: object) => Promise<object>} [provisionProductionWriter]
 * @property {(ctx: object) => Promise<object>} freezeWriter
 * @property {(ctx: object) => Promise<object>} ensureBucket
 * @property {(ctx: object) => Promise<object>} [verifyBucketEmpty]
 * @property {(ctx: object) => Promise<object>} disableR2Dev
 * @property {(ctx: object) => Promise<object>} attachCustomDomain
 * @property {(ctx: object) => Promise<object>} applyCacheRules
 * @property {(ctx: object) => Promise<object>} applyCors
 * @property {(ctx: object) => Promise<object>} configureWaf
 * @property {(ctx: object) => Promise<{ key: string, body: string, exists: true, size?: number, etag?: string|null }>} writeIsolationProbe
 * @property {(ctx: object) => Promise<{ r2DevDisabled: boolean, probes: Array<{url:string,method:string,status:number}>, origins?: string[] }>} probeAnonymousAccess
 * @property {(ctx: object) => Promise<{ key: string, deleted: true }>} deleteIsolationProbe
 * @property {(ctx: object) => Promise<object>} copyPublicPrefixes
 * @property {(ctx: object) => Promise<object>} copyCheckpoints
 * @property {(ctx: object) => Promise<object>} syncGithubEnvironment
 * @property {(ctx: object) => Promise<object>} [deployCloudflareReader]
 * @property {(ctx: object) => Promise<object>} [deployEdgeoneOverseas]
 * @property {(ctx: object) => Promise<{ hash: string, readers: Array<object> } | { status: 'skipped-no-images' | 'skipped-no-release', reason: string }>} verifyImageRouting
 * @property {(ctx: object) => Promise<object>} validateImageCdn
 * @property {(ctx: object) => Promise<object>} runSingleWriterTest
 */

function requireIoMethod(io, name) {
  const fn = io?.[name]
  if (typeof fn !== 'function') {
    throw new Error(`runDevelopmentApply missing injectable I/O method: ${name}`)
  }
  return fn
}

/**
 * Isolation probe lifecycle shared by both live runners (§6.3 / #147):
 * write + positive S3 proof, collect anonymous deny evidence against the
 * plan's public entrypoints, then ALWAYS delete the probe — including when
 * the evidence fails or the fetch throws — so an interrupted apply never
 * leaves probe residue that would poison the clean-bucket guard on retry.
 * Returns the evaluate verdict; the runner decides the abort payload.
 */
async function executeIsolationProbeLifecycle({ io, ctx, completed }) {
  let proof
  let probeResult
  let primaryError = null
  try {
    proof = await requireIoMethod(io, 'writeIsolationProbe')(ctx)
    completed.push('isolation-probe-write')
    probeResult = await requireIoMethod(io, 'probeAnonymousAccess')(ctx)
    completed.push('isolation-probe-check')
  } catch (error) {
    primaryError = error
  } finally {
    if (!proof && ctx.isolationProbeWritten) completed.push('isolation-probe-write')
    if (proof || ctx.isolationProbeWritten) {
      try {
        await requireIoMethod(io, 'deleteIsolationProbe')(ctx)
        completed.push('isolation-probe-cleanup')
      } catch (cleanupError) {
        if (primaryError) {
          primaryError.cleanupFailed = true
          primaryError.message = `${primaryError.message}; probe cleanup ALSO failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        } else {
          cleanupError.cleanupFailed = true
          primaryError = cleanupError
        }
      }
    }
  }
  if (primaryError) throw primaryError
  return {
    ...evaluateIsolationProbe({ r2DevDisabled: Boolean(ctx.r2DevDisabled), probes: probeResult?.probes ?? [] }),
    positiveProof: proof?.exists === true ? { key: proof.key, size: proof.size } : null,
  }
}

function applySecretsFromEnv(env = {}) {
  return [
    env.AIRINGCAL_CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_API_TOKEN,
    env.AIRINGCAL_BANGUMI_TOKEN,
    env.AIRINGCAL_S3_ACCESS_KEY_ID,
    env.AIRINGCAL_S3_SECRET_ACCESS_KEY,
    env.AIRINGCAL_EDGEONE_API_TOKEN,
    env.AIRINGCAL_BARK_URL,
  ]
}

function buildLedgerMeta(completed, ledger, ctx = {}) {
  const mutations = ledger.entries()
  return {
    mutations,
    mutationsSummary: ledger.summarize(),
    mutationsExecuted: mutationsExecutedFrom(completed, mutations),
    writerCredentialState: ctx.writerCredentialState ?? 'not-provisioned',
    observedBucket: ctx.observedBucket ?? null,
  }
}

function classifyRunnerError(error, message) {
  if (error?.errorCategory) return error.errorCategory
  if (/missing capability:/i.test(message)) return 'permission-denied'
  if (/Live I\/O adapter for .+ requires Owner-approved|unsupportedLive|not implemented/i.test(message)) {
    return 'provider-incompatibility'
  }
  if (isAmbiguousTransportError(error)) return 'transport-failure'
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    error instanceof SyntaxError
  ) {
    return 'internal-error'
  }
  if (error?.code) return 'resource-conflict'
  return 'internal-error'
}

/**
 * Execute the development cutover sequence with injectable I/O.
 * Isolation failure aborts before any copy / sync / deploy / writer steps.
 *
 * @param {{
 *   plan: ReturnType<typeof buildDevelopmentDeployPlan>,
 *   env?: Record<string, string | undefined>,
 *   io: DevelopmentApplyIo,
 * }}
 */
export async function runDevelopmentApply({ plan, env = {}, io }) {
  if (!plan || plan.env !== 'development') {
    throw new Error('runDevelopmentApply requires a development plan')
  }
  if (!io || typeof io !== 'object') {
    throw new Error('runDevelopmentApply requires injectable io adapters')
  }

  /** @type {string[]} */
  const completed = []
  const secrets = applySecretsFromEnv(env)
  const ledger = createMutationLedger({ redact: (text) => redactSecrets(text, secrets) })
  const ctx = { plan, env, completed, ledger }

  try {

    const tokenResult = await requireIoMethod(io, 'probeToken')(ctx)
    completed.push('token-probe')
    if (tokenResult && tokenResult.ok === false) {
      const missing = tokenResult.missingScopes ?? []
      return {
        ok: false,
        aborted: true,
        abortCutover: true,
        dualBucketFallback: false,
        developmentWriterEnabled: false,
        exitCode: 2,
        reason: missingScopeExitMessage(missing),
        completed,
        missingScopes: missing,
        ...buildLedgerMeta(completed, ledger, ctx),
      }
    }

    try {
      await requireIoMethod(io, 'deriveAndVerifyS3')(ctx)
    } catch (error) {
      if (Array.isArray(error?.missingScopes) && error.missingScopes.length > 0) {
        completed.push('derive-s3')
        const scopeReason = missingScopeExitMessage(error.missingScopes)
        const overrideNote =
          typeof ctx.s3OverrideRejection === 'string' && ctx.s3OverrideRejection
            ? `${ctx.s3OverrideRejection}; `
            : ''
        return {
          ok: false,
          aborted: true,
          abortCutover: true,
          dualBucketFallback: false,
          developmentWriterEnabled: false,
          exitCode: 2,
          reason: `${overrideNote}${scopeReason}`,
          completed,
          missingScopes: error.missingScopes,
          ...buildLedgerMeta(completed, ledger, ctx),
        }
      }
      throw error
    }
    completed.push('derive-s3')

    await requireIoMethod(io, 'freezeWriter')(ctx)
    completed.push('writer-freeze')

    await requireIoMethod(io, 'ensureBucket')(ctx)
    completed.push('ensure-bucket')

    const disableResult = await requireIoMethod(io, 'disableR2Dev')(ctx)
    completed.push('disable-r2-dev')
    ctx.r2DevDisabled = Boolean(disableResult?.disabled)

    const workerOriginMode = plan.publicOriginMode === 'worker'
    let isolation = null

    if (!workerOriginMode) {
      await requireIoMethod(io, 'attachCustomDomain')(ctx)
      completed.push('attach-custom-domain')

      await requireIoMethod(io, 'applyCacheRules')(ctx)
      completed.push('cache-rules')

      await requireIoMethod(io, 'applyCors')(ctx)
      completed.push('cors')

      await requireIoMethod(io, 'configureWaf')(ctx)
      completed.push('waf-checkpoints')

      isolation = await executeIsolationProbeLifecycle({ io, ctx, completed })
      if (!isolation.ok) {
        return {
          ok: false,
          aborted: true,
          abortCutover: true,
          dualBucketFallback: false,
          developmentWriterEnabled: false,
          exitCode: 1,
          reason: isolation.reason,
          isolation,
          completed,
          ...buildLedgerMeta(completed, ledger, ctx),
        }
      }

      await requireIoMethod(io, 'copyPublicPrefixes')(ctx)
      completed.push('copy-public')

      await requireIoMethod(io, 'copyCheckpoints')(ctx)
      completed.push('copy-checkpoints')
    }

    await requireIoMethod(io, 'syncGithubEnvironment')(ctx)
    completed.push('sync-gh-env')

    if (plan.target === 'cloudflare' || plan.target === 'both') {
      ctx.cloudflareDeploy = await requireIoMethod(io, 'deployCloudflareReader')(ctx)
      completed.push('deploy-cloudflare')
    }
    if (plan.target === 'edgeone' || plan.target === 'both') {
      ctx.edgeoneDeploy = await requireIoMethod(io, 'deployEdgeoneOverseas')(ctx)
      completed.push('deploy-edgeone')
    }

    const imageRouting = await requireIoMethod(io, 'verifyImageRouting')(ctx)
    const imageRoutingSkipped = imageRouting?.status === 'skipped-no-images'
    if (!imageRoutingSkipped) completed.push('image-routing-verify')

    await requireIoMethod(io, 'validateImageCdn')(ctx)
    completed.push('image-cdn-validate')

    if (workerOriginMode) {
      isolation = await executeIsolationProbeLifecycle({ io, ctx, completed })
      if (!isolation.ok) {
        return {
          ok: false,
          aborted: true,
          abortCutover: true,
          dualBucketFallback: false,
          developmentWriterEnabled: false,
          exitCode: 1,
          reason: isolation.reason,
          isolation,
          completed,
          ...buildLedgerMeta(completed, ledger, ctx),
        }
      }
    }

    const writerTest = await requireIoMethod(io, 'runSingleWriterTest')({
      ...ctx,
      developmentWriterEnabled: false,
    })
    const writerTestPending =
      !writerTest || writerTest.dispatched !== true || writerTest.skipped === true
    if (!writerTestPending) completed.push('single-writer-test')

    return {
      ok: true,
      aborted: false,
      abortCutover: false,
      dualBucketFallback: false,
      developmentWriterEnabled: false,
      isolation,
      imageRouting,
      singleWriterTest: writerTestPending
        ? {
            status: 'pending-not-opt-in',
            detail: writerTest?.reason ?? 'no dispatch receipt returned',
          }
        : writerTest,
      ...(writerTestPending
        ? {
            pendingOwnerSteps: [
              'single-writer-test: dispatch one controlled target=development run (set AIRINGCAL_DEPLOY_WRITER_TEST=yes) — a skipped development job is not a pass',
            ],
          }
        : {}),
      completed,
      ...buildLedgerMeta(completed, ledger, ctx),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const missingCapability = /missing capability:/i.test(message)
    const unsupported =
      /Live I\/O adapter for .+ requires Owner-approved|unsupportedLive|not implemented/i.test(
        message,
      )
    if (!missingCapability && !unsupported) throw error
    if (missingCapability) {
      return {
        ok: false,
        aborted: true,
        abortCutover: true,
        dualBucketFallback: false,
        developmentWriterEnabled: false,
        exitCode: 2,
        status: 'missing-capability',
        reason: message,
        completed,
        ...buildLedgerMeta(completed, ledger, ctx),
      }
    }
    const stepMatch = message.match(/Live I\/O adapter for ([^\s]+)/i)
    const unimplementedSteps = stepMatch
      ? [stepMatch[1], ...(plan.ownerGatedLiveSteps ?? [])]
      : [...(plan.ownerGatedLiveSteps ?? [])]
    return {
      ok: false,
      aborted: true,
      abortCutover: true,
      dualBucketFallback: false,
      developmentWriterEnabled: false,
      exitCode: 2,
      status: 'owner-gated',
      reason: `not-implemented: ${message}`,
      pendingOwnerSteps: plan.ownerGatedLiveSteps ?? [],
      unimplementedSteps,
      completed,
      ...buildLedgerMeta(completed, ledger, ctx),
    }
  }
}

/**
 * Production clean-bootstrap apply executor (owner directive 2026-11-25 §10;
 * #208 BUG-003/BUG-004 dependency order & mutation ledger).
 *
 * Ordered sequence:
 *  1. probeToken (management token + selected account validation)
 *  2. deriveAndVerifyS3 (explicit S3 override OR defer until bucket exists; never marks derive-s3 complete when deferred)
 *  3. ensureBucket (bucket discovery, ownership/adoption proof, create/reuse WITHOUT requiring S3)
 *  4. provisionProductionWriter (if deferred, mint & identity/policy/S3-verify dedicated bucket-scoped credential)
 *  5. verifyBucketEmpty (object-level clean-bootstrap emptiness check with verified S3 credentials)
 *  6. disableR2Dev -> edge steps (bucket-domain) -> syncGithubEnvironment -> reader deploys -> image routing/CDN -> worker isolation probe
 */
export async function runProductionApply({
  plan,
  env = {},
  io,
  priorInventory = null,
  bucketAdoptionAuthorized = false,
}) {
  if (!plan || plan.env !== 'production') {
    throw new Error('runProductionApply requires a production plan')
  }
  if (!io || typeof io !== 'object') {
    throw new Error('runProductionApply requires injectable io adapters')
  }
  if (plan.copyFree !== true || plan.dualBucketFallback !== false) {
    throw new Error('runProductionApply requires a copy-free plan (plan.copyFree=true, dualBucketFallback=false)')
  }

  /** @type {string[]} */
  const completed = []
  const secrets = applySecretsFromEnv(env)
  const ledger = createMutationLedger({ redact: (text) => redactSecrets(text, secrets) })
  const ctx = {
    plan,
    env,
    completed,
    ledger,
    priorInventory,
    bucketAdoptionAuthorized: Boolean(bucketAdoptionAuthorized) || String(env.AIRINGCAL_ADOPT_EXISTING_BUCKET ?? '').trim() === 'yes',
    writerCredentialState: 'not-provisioned',
    observedBucket: null,
  }

  try {
    const tokenResult = await requireIoMethod(io, 'probeToken')(ctx)
    if (tokenResult && tokenResult.ok === false) {
      const missing = tokenResult.missingScopes ?? []
      return {
        ok: false,
        aborted: true,
        abortCutover: true,
        dualBucketFallback: false,
        copyFree: true,
        productionWriterEnabled: false,
        exitCode: tokenResult.exitCode ?? 2,
        code: tokenResult.code ?? 'TOKEN_PROBE_FAILED',
        errorCategory: tokenResult.errorCategory ?? 'permission-denied',
        reason: tokenResult.reason || missingScopeExitMessage(missing),
        completed,
        missingScopes: missing,
        ...buildLedgerMeta(completed, ledger, ctx),
      }
    }
    completed.push('token-probe')

    try {
      const deriveResult = await requireIoMethod(io, 'deriveAndVerifyS3')(ctx)
      if (ctx.writerCredentialDeferred === true || deriveResult?.deferred === true) {
        ctx.writerCredentialDeferred = true
        ctx.writerCredentialState = 'deferred-until-bucket'
      } else {
        ctx.writerCredentialState = 'override-verified'
        completed.push('derive-s3')
      }
    } catch (error) {
      ctx.writerCredentialState = 'failed'
      if (Array.isArray(error?.missingScopes) && error.missingScopes.length > 0 && (!error?.errorCategory || error.errorCategory === 'permission-denied')) {
        return {
          ok: false,
          aborted: true,
          abortCutover: true,
          dualBucketFallback: false,
          copyFree: true,
          productionWriterEnabled: false,
          exitCode: error.exitCode ?? 2,
          code: error.code ?? 'S3_CREDENTIAL_FAILED',
          errorCategory: error.errorCategory ?? 'permission-denied',
          reason: redactSecrets(error.message ?? missingScopeExitMessage(error.missingScopes), secrets),
          completed,
          missingScopes: error.missingScopes,
          ...buildLedgerMeta(completed, ledger, ctx),
        }
      }
      throw error
    }

    const bucketResult = await requireIoMethod(io, 'ensureBucket')(ctx)
    if (bucketResult?.observedBucket) ctx.observedBucket = bucketResult.observedBucket
    ctx.bucketResult = bucketResult
    completed.push('ensure-bucket')

    // #195 / #208 BUG-003: Production Writer credential is provisioned ONLY after
    // the bucket exists and ownership/adoption is established by ensureBucket.
    if (ctx.writerCredentialDeferred === true) {
      try {
        await requireIoMethod(io, 'provisionProductionWriter')(ctx)
        ctx.writerCredentialState = 'provisioned-verified'
        completed.push('provision-writer-credential')
      } catch (error) {
        ctx.writerCredentialState = 'failed'
        if (
          Array.isArray(error?.missingScopes)
          && error.missingScopes.length > 0
          && (!error?.errorCategory || error.errorCategory === 'permission-denied')
        ) {
          return {
            ok: false,
            aborted: true,
            abortCutover: true,
            dualBucketFallback: false,
            copyFree: true,
            productionWriterEnabled: false,
            exitCode: error.exitCode ?? 2,
            code: error.code ?? 'WRITER_PROVISION_DENIED',
            errorCategory: 'permission-denied',
            cleanupFailed: Boolean(error.cleanupFailed),
            reason: redactSecrets(error.message ?? missingScopeExitMessage(error.missingScopes), secrets),
            completed,
            missingScopes: error.missingScopes,
            ...buildLedgerMeta(completed, ledger, ctx),
          }
        }
        throw error
      }
    }

    // Object-level emptiness verification ALWAYS runs after credential provisioning/verification.
    await requireIoMethod(io, 'verifyBucketEmpty')(ctx)
    completed.push('verify-bucket-empty')

    const disableResult = await requireIoMethod(io, 'disableR2Dev')(ctx)
    completed.push('disable-r2-dev')
    ctx.r2DevDisabled = Boolean(disableResult?.disabled)

    const workerOriginMode = plan.publicOriginMode === 'worker'
    let isolation = null

    if (!workerOriginMode) {
      await requireIoMethod(io, 'attachCustomDomain')(ctx)
      completed.push('attach-custom-domain')

      await requireIoMethod(io, 'applyCacheRules')(ctx)
      completed.push('cache-rules')

      await requireIoMethod(io, 'applyCors')(ctx)
      completed.push('cors')

      await requireIoMethod(io, 'configureWaf')(ctx)
      completed.push('waf-checkpoints')

      isolation = await executeIsolationProbeLifecycle({ io, ctx, completed })
      if (!isolation.ok) {
        return {
          ok: false,
          aborted: true,
          abortCutover: true,
          dualBucketFallback: false,
          copyFree: true,
          productionWriterEnabled: false,
          exitCode: 1,
          code: 'ISOLATION_FAILED',
          errorCategory: 'resource-conflict',
          reason: isolation.reason,
          isolation,
          completed,
          ...buildLedgerMeta(completed, ledger, ctx),
        }
      }
    }

    await requireIoMethod(io, 'syncGithubEnvironment')(ctx)
    completed.push('sync-gh-env')

    if (plan.target === 'cloudflare' || plan.target === 'both') {
      ctx.cloudflareDeploy = await requireIoMethod(io, 'deployCloudflareReader')(ctx)
      completed.push('deploy-cloudflare')
    }
    if (plan.target === 'edgeone' || plan.target === 'both') {
      ctx.edgeoneDeploy = await requireIoMethod(io, 'deployEdgeoneOverseas')(ctx)
      completed.push('deploy-edgeone')
    }

    const imageRouting = await requireIoMethod(io, 'verifyImageRouting')(ctx)
    if (
      imageRouting?.status !== 'skipped-no-images'
      && imageRouting?.status !== 'skipped-no-release'
    ) {
      completed.push('image-routing-verify')
    }

    await requireIoMethod(io, 'validateImageCdn')(ctx)
    completed.push('image-cdn-validate')

    if (workerOriginMode) {
      isolation = await executeIsolationProbeLifecycle({ io, ctx, completed })
      if (!isolation.ok) {
        return {
          ok: false,
          aborted: true,
          abortCutover: true,
          dualBucketFallback: false,
          copyFree: true,
          productionWriterEnabled: false,
          exitCode: 1,
          code: 'ISOLATION_FAILED',
          errorCategory: 'resource-conflict',
          reason: isolation.reason,
          isolation,
          completed,
          ...buildLedgerMeta(completed, ledger, ctx),
        }
      }
    }

    return {
      ok: true,
      aborted: false,
      abortCutover: false,
      dualBucketFallback: false,
      copyFree: true,
      productionWriterEnabled: false,
      bootstrapWriterEnabled: false,
      isolation,
      imageRouting,
      pendingOwnerSteps: [
        'first Bangumi Full Sync: Owner runs portable-writer.yml workflow_dispatch target=production force_mode=full with AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED=true (schedule stays gated by AIRINGCAL_WRITER_ENABLED)',
        'production cutover sign-off: reader-delivery-accept + docs/v3/production-acceptance.md checklist',
      ],
      completed,
      ...buildLedgerMeta(completed, ledger, ctx),
    }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
    const missingCapability = /missing capability:/i.test(message)
    const unsupported =
      /Live I\/O adapter for .+ requires Owner-approved|unsupportedLive|not implemented/i.test(
        message,
      )
    const errorCategory = classifyRunnerError(error, message)
    if (!missingCapability && !unsupported) {
      return {
        ok: false,
        aborted: true,
        abortCutover: true,
        dualBucketFallback: false,
        copyFree: true,
        productionWriterEnabled: false,
        exitCode: error?.exitCode ?? 1,
        code: error?.code ?? null,
        errorCategory,
        cleanupFailed: Boolean(error?.cleanupFailed),
        ...(Array.isArray(error?.missingScopes) && error.missingScopes.length > 0
          ? { missingScopes: error.missingScopes }
          : {}),
        reason: message,
        completed,
        ...buildLedgerMeta(completed, ledger, ctx),
      }
    }
    if (missingCapability) {
      return {
        ok: false,
        aborted: true,
        abortCutover: true,
        dualBucketFallback: false,
        copyFree: true,
        productionWriterEnabled: false,
        exitCode: 2,
        status: 'missing-capability',
        code: error?.code ?? 'MISSING_CAPABILITY',
        errorCategory,
        reason: message,
        completed,
        ...buildLedgerMeta(completed, ledger, ctx),
      }
    }
    const stepMatch = message.match(/Live I\/O adapter for ([^\s]+)/i)
    const unimplementedSteps = stepMatch
      ? [stepMatch[1], ...(plan.ownerGatedLiveSteps ?? [])]
      : [...(plan.ownerGatedLiveSteps ?? [])]
    return {
      ok: false,
      aborted: true,
      abortCutover: true,
      dualBucketFallback: false,
      copyFree: true,
      productionWriterEnabled: false,
      exitCode: 2,
      status: 'owner-gated',
      code: error?.code ?? 'OWNER_GATED',
      errorCategory,
      reason: `not-implemented: ${message}`,
      pendingOwnerSteps: plan.ownerGatedLiveSteps ?? [],
      unimplementedSteps,
      completed,
      ...buildLedgerMeta(completed, ledger, ctx),
    }
  }
}
