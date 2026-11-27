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

/**
 * #205 BUG-001: the authorized apply-mode plan must describe exactly the
 * configuration the Owner reviewed. Only the mode/reason fields may differ;
 * any identity drift aborts before the executor runs.
 */
export function assertApplyPlanMatchesReview(reviewedPlan, applyPlan) {
  if (!reviewedPlan || !applyPlan) throw new Error('Both reviewed and apply plans are required')
  if (applyPlan.mode !== 'apply') {
    throw new Error(`Authorized execution requires an apply-mode plan (got "${applyPlan.mode}")`)
  }
  const fields = [
    'env', 'target', 'bucket', 'cloudflareWorkerName', 'publicBaseUrl',
    'publicOriginMode', 'workerOrigin', 'repository', 'operation',
  ]
  const drift = fields.filter((field) => (reviewedPlan[field] ?? 'install') !== (applyPlan[field] ?? 'install'))
  const reviewedEdgeone = reviewedPlan.target === 'cloudflare' ? null : reviewedPlan.edgeone?.project ?? null
  const applyEdgeone = applyPlan.target === 'cloudflare' ? null : applyPlan.edgeone?.project ?? null
  if (reviewedEdgeone !== applyEdgeone) drift.push('edgeone.project')
  if (drift.length > 0) {
    throw new Error(
      `Refusing to apply: configuration drifted after review (${drift.join(', ')}). ` +
      'Re-run the wizard and review the plan again.',
    )
  }
  return applyPlan
}

/** Redact email addresses from account display names before writing public/local receipts. */
export function sanitizeAccountName(name) {
  return String(name ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>')
    .trim()
}

/**
 * #208 UX-013: Explicit terminal URL formatting so failed/un-deployed
 * installations never report a proposed Worker URL as a live verified endpoint.
 */
export function formatTerminalEndpointLine({ verdict, applied = false, publicBaseUrl = null, plannedPublicBaseUrl = null }) {
  const planned = plannedPublicBaseUrl || publicBaseUrl || '(none)'
  if (!applied || verdict === 'DEPLOY_FAILED' || verdict === 'CANCELLED') {
    return `Planned Public URL — not yet deployed or verified: ${planned}`
  }
  if (verdict === 'READY') {
    return `Verified Public URL: ${publicBaseUrl ?? planned}`
  }
  return `Deployed Public URL (not yet verified ready): ${publicBaseUrl ?? planned}`
}

/**
 * #208 UX-012: Classify an aborted apply result into safe recovery actions.
 * Never allows blind retry on internal errors, unknown remote outcomes,
 * unverified cleanups, dirty buckets, wrong accounts, or unproven ownership.
 */
export function classifyFailureRecovery({ result, environment = 'production' }) {
  const summary = result?.mutationsSummary ?? {
    confirmed: [],
    alreadyExists: [],
    failed: [],
    unknown: [],
    compensations: [],
    unverifiedCleanups: [],
    executedOps: Array.isArray(result?.mutationsExecuted) ? result.mutationsExecuted : [],
  }
  const errorCategory = result?.errorCategory ?? 'internal-error'
  const code = result?.code ?? null
  const hasUnknown = Array.isArray(summary.unknown) && summary.unknown.length > 0
  const hasUnverifiedCleanup =
    Boolean(result?.cleanupFailed) ||
    (Array.isArray(summary.unverifiedCleanups) && summary.unverifiedCleanups.length > 0)

  const existingResources = []
  if (result?.observedBucket?.exists) {
    existingResources.push(`R2 bucket ${result.observedBucket.name} (account ${result.observedBucket.accountId ?? 'unknown'})`)
  }
  for (const entry of summary.confirmed ?? []) {
    if (entry.op === 'r2-bucket-create' && !existingResources.some((r) => r.includes(entry.target))) {
      existingResources.push(`R2 bucket ${entry.target} (created in this attempt)`)
    } else if (entry.op === 'writer-token-create') {
      existingResources.push(`Cloudflare API token ${entry.target} (${entry.detail ?? 'created'})`)
    } else if (entry.op === 'github-environment-ensure') {
      existingResources.push(`GitHub Environment ${entry.target}`)
    } else if (entry.op === 'worker-deploy') {
      existingResources.push(`Cloudflare Worker ${entry.target}`)
    }
  }
  for (const entry of summary.alreadyExists ?? []) {
    if (entry.op === 'r2-bucket-create' && !existingResources.some((r) => r.includes(entry.target))) {
      existingResources.push(`R2 bucket ${entry.target} (pre-existing, adopted/reused)`)
    }
  }

  let allowedActions
  if (errorCategory === 'internal-error') {
    allowedActions = ['details', 'exit']
  } else if (hasUnverifiedCleanup || hasUnknown) {
    allowedActions = ['reconcile', 'details', 'exit']
  } else if (
    code === 'BUCKET_NOT_EMPTY' ||
    code === 'WRONG_ACCOUNT' ||
    code === 'FOREIGN_OR_INCONSISTENT_INSTALLATION' ||
    code === 'WORKER_BINDING_MISMATCH' ||
    code === 'UNSUPPORTED_LEGACY_CONFIG' ||
    code === 'REPOSITORY_INVALID' ||
    code === 'REPOSITORY_CONFLICT' ||
    code === 'REPOSITORY_UNRESOLVED' ||
    code === 'REPOSITORY_ORIGIN_MISSING' ||
    code === 'REPOSITORY_ORIGIN_UNSUPPORTED' ||
    code === 'REPOSITORY_NOT_FOUND' ||
    code === 'REPOSITORY_PERMISSION_DENIED' ||
    code === 'WORKFLOW_UNAVAILABLE' ||
    code === 'RELEASE_IDENTITY_REQUIRED' ||
    code === 'RELEASE_IDENTITY_INVALID' ||
    code === 'RELEASE_REF_SHA_MISMATCH' ||
    code === 'RELEASE_CHANGE_UNAUTHORIZED'
  ) {
    allowedActions = ['review', 'details', 'exit']
  } else if (code === 'BUCKET_OWNERSHIP_UNPROVEN' || code === 'OWNERSHIP_EVIDENCE_INSUFFICIENT') {
    allowedActions = ['reconcile', 'review', 'details', 'exit']
  } else if (
    (Array.isArray(result?.missingScopes) && result.missingScopes.length > 0) ||
    code === 'S3_OVERRIDE_REJECTED' ||
    code === 'WRITER_TOKEN_COLLISION' ||
    code === 'WRITER_SCOPE_VIOLATION' ||
    code === 'WRITER_TOKEN_INACTIVE'
  ) {
    allowedActions = ['supply-s3', 'reconcile', 'review', 'details', 'exit']
  } else if (errorCategory === 'transport-failure') {
    allowedActions = ['retry', 'reconcile', 'review', 'details', 'exit']
  } else {
    allowedActions = ['reconcile', 'review', 'details', 'exit']
  }

  return {
    environment,
    errorCategory,
    code,
    hasUnknown,
    hasUnverifiedCleanup,
    requiresFreshAuthorization: true,
    confirmedMutations: summary.confirmed ?? [],
    existingResources,
    failedMutations: summary.failed ?? [],
    unknownOutcomes: summary.unknown ?? [],
    unverifiedCleanups: summary.unverifiedCleanups ?? [],
    allowedActions,
  }
}

/** Sanitized per-environment inventory (no credential values, ever). */
export function buildInventory({
  plan,
  account,
  identity,
  environment,
  customDomain = '',
  buildSha,
  attemptedAt = null,
  deployedAt = null,
  writerCredential = null,
  writerCredentialState = null,
  credentialVerification = null,
  operation = null,
  installationState = null,
  verification = null,
  verdict = null,
  reason = null,
  observed = null,
  resources = null,
  mutationReceipts = [],
}) {
  const plannedPublicBaseUrl = plan.publicBaseUrl ?? plan.workerOrigin
  const applied = verdict !== 'DEPLOY_FAILED' && verdict !== 'CANCELLED' && Boolean(deployedAt || verdict)
  const resolvedAttemptedAt = attemptedAt ?? deployedAt ?? new Date().toISOString()
  const resolvedDeployedAt = applied ? (deployedAt ?? resolvedAttemptedAt) : null

  return {
    schema: 'airingcal.inventory.v1',
    environment,
    operation: operation ?? plan.operation ?? 'install',
    installationState: installationState ?? null,
    repository: plan.repository,
    cloudflare: {
      accountId: account.id,
      accountName: sanitizeAccountName(account.name),
      workersDevSubdomain: plan.workerOrigin
        ? new URL(plan.workerOrigin).host.replace(/\.workers\.dev$/, '').split('.').slice(1).join('.')
        : '',
    },
    bucket: plan.bucket,
    worker: {
      name: plan.cloudflareWorkerName,
      deployed: applied,
      origin: applied ? plan.workerOrigin : null,
      plannedOrigin: plan.workerOrigin,
      customDomain: customDomain || null,
    },
    publicBaseUrl: applied ? plannedPublicBaseUrl : null,
    plannedPublicBaseUrl,
    originMode: plan.publicOriginMode,
    github: {
      environment: environment,
      gateVariable: gateVariableName(environment),
    },
    bangumi: {
      primaryUserId: identity.userId,
      username: identity.username,
    },
    planned: {
      bucket: plan.bucket,
      workerName: plan.cloudflareWorkerName,
      workerOrigin: plan.workerOrigin,
      publicBaseUrl: plannedPublicBaseUrl,
      customDomain: customDomain || null,
      originMode: plan.publicOriginMode,
      githubEnvironment: environment,
      gateVariable: gateVariableName(environment),
    },
    observed: observed ?? null,
    resources: resources ?? {
      bucket: { name: plan.bucket, state: applied ? 'verified-empty' : 'unknown' },
      worker: { name: plan.cloudflareWorkerName, state: applied ? 'deployed' : 'not-deployed', url: applied ? plan.workerOrigin : null },
      githubEnvironment: { name: environment, state: applied ? 'synced' : 'unknown' },
    },
    // #195 / #208 UX-013: record what the engine ACTUALLY provisioned/verified,
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
    writerCredentialState: writerCredentialState ?? (writerCredential ? 'verified' : 'not-provisioned'),
    credentialVerification: credentialVerification ?? null,
    deployment: {
      gitSha: buildSha ?? null,
      attemptedAt: resolvedAttemptedAt,
      deployedAt: resolvedDeployedAt,
      verdict,
      reason: reason ?? null,
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
  operation = 'install',
  credentialRuntimeVerification = null,
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
  if (operation === 'update' && !wantSync) {
    if (verificationError || (verification && verification.pass !== true)) {
      return {
        verdict: 'VERIFICATION_FAILED',
        reason: String(verificationError?.message ?? verificationError ?? 'live verifier did not pass').slice(0, 400),
      }
    }
    if (credentialRuntimeVerification === 'not-verified-github-secret-only' || !verification) {
      return {
        verdict: 'UPDATED_PARTIAL_VERIFICATION',
        reason:
          'Existing installation updated and anonymous checkpoint route denial verified; Writer S3 credential runtime access, positive private-object S3 existence proof, and live S3-authenticated verifier were not executed because existing GitHub S3 secrets were reused without local S3 credentials',
      }
    }
    return { verdict: 'READY', reason: null }
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
