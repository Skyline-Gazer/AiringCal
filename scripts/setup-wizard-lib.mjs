/**
 * Pure helpers for `pnpm setup` (#195 P4/P5): environment assembly, plan
 * rendering, inventory, gate naming and first-sync step detection. The
 * orchestration lives in `setup-wizard.mjs`; keeping these pure makes the
 * interactive and headless modes share one resolver/planner.
 */

import { ALLOWED_REPOSITORY } from './deploy-env-lib.mjs'

export const WIZARD_REPOSITORY = ALLOWED_REPOSITORY
export const WIZARD_ENVIRONMENTS = Object.freeze(['production', 'development'])
export const INVENTORY_DIR = '.airingcal'

/** Writer gate variable that the first-sync job step reads, per environment. */
export function gateVariableName(environment) {
  if (environment === 'production') return 'AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED'
  if (environment === 'development') return 'AIRINGCAL_DEVELOPMENT_WRITER_ENABLED'
  throw new Error(`Unknown environment: ${environment}`)
}

/** Step name pattern that proves the run passed its in-job gate. */
export function gateStepPattern(environment) {
  return environment === 'production' ? /bootstrap gate/i : /writer gate/i
}

/** Auto-select vs prompt rule for account discovery (never guess an id). */
export function chooseAccount(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No eligible Cloudflare account was discovered')
  }
  if (accounts.length === 1) return { account: accounts[0], prompt: null }
  return { account: null, prompt: accounts }
}

/**
 * Assemble the deploy-env environment object for the wizard's two-token path.
 * Everything except the two tokens and the derived identities has a
 * documented default; unknown keys are never invented.
 */
export function wizardEnvironment({
  environment,
  cloudflareToken,
  accountId,
  workersSubdomain,
  bangumiToken,
  identity,
  usersJson,
  deployTarget = 'cloudflare',
  customDomain = '',
  zoneId = '',
  dotenvPath,
  episodeProgress = 'on',
}) {
  if (!WIZARD_ENVIRONMENTS.includes(environment)) {
    throw new Error(`Environment must be production|development (got "${environment}")`)
  }
  if (!cloudflareToken) throw new Error('Cloudflare API token is required')
  if (!/^[0-9a-f]{32}$/i.test(String(accountId ?? ''))) {
    throw new Error('A 32-character Cloudflare account id is required (discovered, never guessed)')
  }
  if (!bangumiToken) throw new Error('Bangumi personal access token is required')
  if (!identity?.userId || !identity?.username) throw new Error('Bangumi identity is required')
  const env = {
    AIRINGCAL_ENV: environment,
    AIRINGCAL_DEPLOY_TARGET: deployTarget,
    AIRINGCAL_CLOUDFLARE_API_TOKEN: cloudflareToken,
    AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: String(accountId).toLowerCase(),
    AIRINGCAL_BANGUMI_TOKEN: bangumiToken,
    AIRINGCAL_PRIMARY_USER_ID: String(identity.userId),
    AIRINGCAL_USERS_JSON: usersJson,
    AIRINGCAL_WORKERS_DEV_SUBDOMAIN: workersSubdomain || 'r7a',
    AIRINGCAL_EPISODE_PROGRESS: episodeProgress,
  }
  if (dotenvPath) env.AIRINGCAL_DOTENV_PATH = dotenvPath
  if (customDomain) {
    env.AIRINGCAL_PUBLIC_BASE_URL = `https://${customDomain}`
    env.AIRINGCAL_WORKER_CUSTOM_DOMAIN = customDomain
    env.AIRINGCAL_ZONE_ID = zoneId
  }
  return env
}

/** Human-readable plan rendering for the confirmation screen. */
export function formatPlan(plan) {
  const lines = []
  lines.push(`Environment: ${plan.env}`)
  lines.push(`Mode: ${plan.mode}` + (plan.applyAuthorized ? ' (authorized)' : ''))
  lines.push(`Repository: ${plan.repository}`)
  lines.push(`Bucket: ${plan.bucket} (private; r2.dev disabled; no anonymous object access)`)
  lines.push(`Worker: ${plan.cloudflareWorkerName}`)
  lines.push(`Origin mode: ${plan.publicOriginMode}`)
  lines.push(`Public base: ${plan.publicBaseUrl ?? plan.workerOrigin}`)
  lines.push(
    plan.edgeone?.project
      ? `EdgeOne project: ${plan.edgeone.project} (${plan.edgeone.region})`
      : null,
  )
  lines.push('Steps:')
  plan.steps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.id}${step.mutates ? ' [mutates]' : ' [read-only]'}`)
    if (step.title) lines.push(`     ${step.title}`)
  })
  return lines.filter((line) => line !== null).join('\n')
}

/** Sanitized per-environment inventory (no credential values, ever). */
export function buildInventory({
  plan,
  account,
  identity,
  environment,
  customDomain = '',
  buildSha,
  deployedAt,
  writerCredential = null,
  verification = null,
  verdict = null,
  mutationReceipts = [],
}) {
  return {
    schema: 'airingcal.inventory.v1',
    environment,
    repository: plan.repository,
    cloudflare: {
      accountId: account.id,
      accountName: account.name,
      workersDevSubdomain: plan.workerOrigin
        ? new URL(plan.workerOrigin).host.replace(/\.workers\.dev$/, '').split('.').slice(1).join('.')
        : '',
    },
    bucket: plan.bucket,
    worker: {
      name: plan.cloudflareWorkerName,
      origin: plan.workerOrigin,
      customDomain: customDomain || null,
    },
    publicBaseUrl: plan.publicBaseUrl ?? plan.workerOrigin,
    originMode: plan.publicOriginMode,
    github: {
      environment: environment,
      gateVariable: gateVariableName(environment),
    },
    bangumi: {
      primaryUserId: identity.userId,
      username: identity.username,
    },
    // #195 correction: record what the engine ACTUALLY provisioned/verified,
    // never the desired canonical name when no such token exists.
    writerCredential: writerCredential
      ? {
          source: writerCredential.source ?? 'unknown',
          scope: writerCredential.scope ?? 'unverified',
          accessKeyId: writerCredential.accessKeyId ?? null,
          tokenName: writerCredential.tokenName ?? null,
          tokenId: writerCredential.tokenId ?? null,
        }
      : null,
    deployment: {
      gitSha: buildSha ?? null,
      deployedAt: deployedAt ?? null,
      verdict,
    },
    mutationReceipts,
    verification: verification ?? null,
  }
}

/** Refuse to write an inventory that accidentally carries a secret-looking value. */
export function assertInventorySanitized(inventory, secrets = []) {
  const json = JSON.stringify(inventory)
  for (const secret of secrets) {
    if (secret && json.includes(secret)) {
      throw new Error('Refusing to write inventory: a credential value leaked into it')
    }
  }
  // Exempt only the legitimate writerCredential block (ids/scope); any other
  // token-shaped string field is a leak.
  const { writerCredential: _writerCredential, ...rest } = inventory
  if (/"token"\s*:\s*"[A-Za-z0-9_-]{20,}"/.test(JSON.stringify(rest))) {
    throw new Error('Refusing to write inventory: token-shaped value detected outside writerCredential')
  }
  return inventory
}

/**
 * Detect the gate step's outcome inside a `gh run view --json jobs` payload.
 * Returns 'passed' | 'failed' | 'pending' — never a boolean guess.
 */
export function gateStepVerdict(runJobs, pattern) {
  const jobs = Array.isArray(runJobs) ? runJobs : []
  for (const job of jobs) {
    for (const step of job?.steps ?? []) {
      if (!pattern.test(String(step?.name ?? ''))) continue
      if (step.conclusion === 'success') return 'passed'
      if (step.conclusion && step.conclusion !== 'success') return 'failed'
      return 'pending'
    }
  }
  return 'pending'
}

/**
 * #195 correction: a single, explicit terminal verdict. READY requires the
 * intended deployment, a successful first sync AND a passing live verifier;
 * a deferred sync is a valid infrastructure outcome, not "Ready".
 */
export function computeVerdict({
  applied,
  wantSync,
  headless = false,
  sync = null,
  syncError = null,
  verification = null,
  verificationError = null,
  applyReason = null,
}) {
  if (!applied) {
    return { verdict: 'DEPLOY_FAILED', reason: applyReason ?? 'apply aborted' }
  }
  if (syncError) {
    return { verdict: 'SYNC_FAILED', reason: String(syncError?.message ?? syncError).slice(0, 400) }
  }
  if (!wantSync) {
    return {
      verdict: headless ? 'DEPLOYED' : 'AWAITING_FIRST_SYNC',
      reason: headless
        ? 'Infrastructure deployed; first Full Sync was not requested'
        : 'First Full Sync intentionally deferred; the deployment is not initialized yet',
    }
  }
  if (verificationError || !verification || verification.pass !== true) {
    return {
      verdict: 'VERIFICATION_FAILED',
      reason: String(verificationError?.message ?? verificationError ?? 'live verifier did not pass').slice(0, 400),
    }
  }
  return { verdict: 'READY', reason: null }
}
