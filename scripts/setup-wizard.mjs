#!/usr/bin/env node
/**
 * `pnpm setup` — the single interactive entrypoint (#195 P4/P5).
 *
 * Wraps the ONE deployment engine (`deploy-env.mjs` plan builders + apply
 * runners + live I/O adapters). It never re-implements provisioning: every
 * mutation below runs through `runDevelopmentApply` / `runProductionApply`
 * with the same gates, isolation proof and GitHub Environment sync as the
 * headless CLI.
 *
 * Two masked tokens are the normal input; accounts, the workers.dev
 * subdomain, the Bangumi identity, USERS_JSON and the ordered plan are all
 * discovered. Nothing is echoed, written to argv, or persisted in plaintext
 * by default.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  deriveDevelopmentConfig,
  deriveProductionConfig,
  loadDotEnvFile,
  loadProductionDeployEnv,
  resolveDeployDotenvPath,
  runDevelopmentApply,
  runProductionApply,
} from './deploy-env-lib.mjs'
import { createLiveDevelopmentApplyIo } from './deploy-env.mjs'
import {
  IdentityError,
  deriveUsersConfig,
  fetchCloudflareAccounts,
  fetchDnsRecordsForName,
  fetchWorkersSubdomain,
  fetchZones,
  resolveBangumiIdentity,
  verifyCloudflareToken,
} from './setup-identities.mjs'
import { askConfirm, askSecret, askSelect, askText, WizardAbort } from './setup-prompt.mjs'
import { credentialLinks, resolveDocumentation } from './setup-docs.mjs'
import { createUi, credentialSection } from './setup-ui.mjs'
import { validateCredentials } from './setup-validate.mjs'
import {
  INVENTORY_DIR,
  WIZARD_ENVIRONMENTS,
  WIZARD_REPOSITORY,
  assertInventorySanitized,
  buildInventory,
  assertApplyPlanMatchesReview,
  computeVerdict,
  chooseAccount,
  formatPlan,
  gateStepPattern,
  gateVariableName,
  gateStepVerdict,
  wizardEnvironment,
} from './setup-wizard-lib.mjs'

export const ENVIRONMENT_OPTIONS = Object.freeze([
  { value: 'production', label: 'Production', hint: 'Standard installation for personal use (recommended)' },
  { value: 'development', label: 'Development', hint: 'Additional environment for developing and testing AiringCal' },
])

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function log(message) {
  process.stderr.write(`${message}\n`)
}

function defaultSpawn(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...options })
}

function run(cmd, args, { spawnSyncImpl = spawnSync, input, env, allowFailure = false } = {}) {
  const result = spawnSyncImpl(cmd, args, { encoding: 'utf8', cwd: ROOT, input, env })
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 400)
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status}): ${detail}`)
  }
  return result
}

export async function preflight({ spawnSyncImpl = spawnSync, nodeVersion = process.versions.node } = {}) {
  const major = Number(String(nodeVersion).split('.')[0])
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Node ${nodeVersion} is too old; the wizard needs Node >= 20`)
  }
  run('gh', ['--version'], { spawnSyncImpl })
  run('gh', ['auth', 'status'], { spawnSyncImpl })
  run('pnpm', ['exec', 'wrangler', '--version'], { spawnSyncImpl })
  return { node: nodeVersion, ok: true }
}

/** Resolve both tokens from env/dotenv (headless) or masked prompts. */
export async function resolveTokens({ io, env = {}, log: logFn = log, prompts = null }) {
  const ask = prompts?.password ?? ((message) => askSecret(message, io))
  let cloudflareToken = String(env.AIRINGCAL_CLOUDFLARE_API_TOKEN ?? '').trim()
  let bangumiToken = String(env.AIRINGCAL_BANGUMI_TOKEN ?? '').trim()
  if (cloudflareToken) logFn('Using AIRINGCAL_CLOUDFLARE_API_TOKEN from the environment (in-memory).')
  else cloudflareToken = await ask('Cloudflare API Token')
  if (bangumiToken) logFn('Using AIRINGCAL_BANGUMI_TOKEN from the environment (in-memory).')
  else bangumiToken = await ask('Bangumi Personal Access Token')
  if (!cloudflareToken || !bangumiToken) throw new WizardAbort('Both tokens are required')
  return { cloudflareToken, bangumiToken }
}

/**
 * Discover account, workers.dev subdomain and Bangumi identity. A single
 * account auto-selects; multiple prompt; an explicit AIRINGCAL account id
 * still verifies ownership and permissions rather than guessing.
 */
export async function discoverIdentity({
  fetchImpl = globalThis.fetch,
  cloudflareToken,
  bangumiToken,
  io,
  env = {},
  log: logFn = log,
  prompts = null,
}) {
  await verifyCloudflareToken(fetchImpl, cloudflareToken)
  const accounts = await fetchCloudflareAccounts(fetchImpl, cloudflareToken, { secrets: [cloudflareToken] })
  const explicitAccountId = String(
    env.AIRINGCAL_CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID ?? '',
  ).trim().toLowerCase()
  let account
  if (explicitAccountId) {
    account = accounts.find((entry) => entry.id.toLowerCase() === explicitAccountId)
    if (!account) {
      throw new IdentityError(
        'CF_ACCOUNT_NOT_ELIGIBLE',
        `AIRINGCAL_CLOUDFLARE_ACCOUNT_ID ${explicitAccountId} is not visible to this token (visible: ${accounts.map((a) => a.id).join(', ')})`,
      )
    }
  } else {
    const choice = chooseAccount(accounts)
    account = choice.account
    if (!account) {
      account = prompts?.select
        ? await prompts.select({
            message: 'Select the Cloudflare account for AiringCal',
            options: choice.prompt.map((entry) => ({ label: entry.name, hint: entry.id, value: entry })),
          })
        : await askSelect(
            'Select the Cloudflare account for AiringCal',
            choice.prompt.map((entry) => ({ title: entry.name, hint: entry.id, value: entry })),
            io,
          )
    }
  }
  logFn(`Cloudflare account: ${account.name} (${account.id})`)
  const workersSubdomain = await fetchWorkersSubdomain(fetchImpl, cloudflareToken, account.id, {
    secrets: [cloudflareToken],
  })
  logFn(`workers.dev subdomain: ${workersSubdomain}`)
  const identity = await resolveBangumiIdentity(fetchImpl, bangumiToken)
  logFn(`Bangumi identity: ${identity.username} (id ${identity.userId})`)
  const usersJson = deriveUsersConfig(identity)
  return { account, workersSubdomain, identity, usersJson }
}

/**
 * Optional Worker custom domain. Default mode is the workers.dev URL (no zone
 * prompt). Custom mode discovers zones, refuses takeover of an existing DNS
 * name, and returns the explicit binding inputs; DNS/TLS are provisioned by
 * Cloudflare when the materialized config deploys with `custom_domain`.
 */
export async function planCustomDomain({
  fetchImpl = globalThis.fetch,
  cloudflareToken,
  account,
  io,
  log: logFn = log,
  assume,
  hostnameHint = '',
  zoneHint = '',
  allowTakeover = false,
  prompts = null,
}) {
  const confirm = prompts?.confirm ?? ((message, initialValue) => askConfirm(message, io, { defaultYes: Boolean(initialValue) }))
  const select = prompts?.select ?? (({ message, options }) => askSelect(message, options.map((option) => ({
    title: option.label,
    hint: option.hint,
    value: option.value,
  })), io))
  const text = prompts?.text ?? (({ message, validate }) => askText(message, io, { validate }))
  const wantsCustom =
    assume ?? (await confirm('Attach a Custom Domain to the Worker? (default: workers.dev URL only)'))
  if (!wantsCustom) return { customDomain: '', zoneId: '' }
  const zones = await fetchZones(fetchImpl, cloudflareToken, account.id, { secrets: [cloudflareToken] })
  if (zones.length === 0) {
    throw new IdentityError(
      'CF_NO_ZONES',
      'This token/account sees no Cloudflare zones; a Worker custom domain needs a zone in the same account. ' +
      'Add the zone (or use the default workers.dev URL) and retry.',
    )
  }
  // #195 review: an environment-supplied zone/hostname must be the values the
  // checkout and DNS-occupancy check operate on — never a prompt answer that
  // is then discarded in favour of the env value.
  let zone
  if (zoneHint) {
    zone = zones.find((entry) => entry.id === zoneHint || entry.name === zoneHint)
    if (!zone) {
      throw new IdentityError(
        'CF_ZONE_NOT_FOUND',
        `AIRINGCAL_ZONE_ID "${zoneHint}" is not visible to this token (visible zones: ${zones.map((z) => `${z.name}/${z.id}`).join(', ')})`,
      )
    }
  } else {
    zone = await select({
      message: 'Select the zone for the Custom Domain',
      options: zones.map((entry) => ({ label: entry.name, hint: entry.status, value: entry })),
    })
  }
  const hostname = hostnameHint
    ? String(hostnameHint).trim().toLowerCase()
    : await text({
        message: `Hostname under ${zone.name} (e.g. anime.${zone.name})`,
        validate: (value) =>
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)
            ? null
            : 'Enter a valid lowercase hostname',
      })
  const records = await fetchDnsRecordsForName(fetchImpl, cloudflareToken, zone.id, hostname, {
    secrets: [cloudflareToken],
  })
  if (records.length > 0) {
    logFn(`Existing DNS records for ${hostname}: ${records.map((r) => `${r.type} -> ${r.content}`).join(', ')}`)
    if (allowTakeover) {
      logFn(`Takeover of ${hostname} explicitly authorised (AIRINGCAL_ALLOW_CUSTOM_DOMAIN_TAKEOVER=yes).`)
    } else if (io?.input?.isTTY) {
      const takeOver = await confirm(
        `DNS name ${hostname} is already in use. Bind this Worker to it anyway (Cloudflare will replace the record)?`,
      )
      if (!takeOver) {
        throw new WizardAbort(
          `Refusing to take over ${hostname}. Choose another hostname, or remove the existing record first.`,
        )
      }
    } else {
      throw new WizardAbort(
        `Refusing to take over ${hostname} non-interactively. Remove the existing record, choose another hostname, ` +
        'or set AIRINGCAL_ALLOW_CUSTOM_DOMAIN_TAKEOVER=yes to authorise replacing it.',
      )
    }
  }
  logFn(`Custom domain plan: ${hostname} → Worker custom_domain route (zone ${zone.name})`)
  return { customDomain: hostname, zoneId: zone.id }
}

/** Build the plan through the shared derive functions (no remote calls). */
export function buildPlanForEnvironment(env, { target = 'cloudflare', mode = 'dry-run' } = {}) {
  const derived =
    env.AIRINGCAL_ENV === 'production'
      ? deriveProductionConfig(env, { target, mode, gitSha: resolveGitSha() })
      : deriveDevelopmentConfig(env, { target, mode })
  return derived
}

function resolveGitSha(spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT })
  return String(result?.stdout ?? '').trim() || null
}

/**
 * Execute the approved plan through the canonical apply runners. Production
 * only proceeds when the interactive confirmation translated into the two
 * existing gates; the headless mode keeps requiring them from the env.
 */
export async function applyPlan({ env, plan, log: logFn = log, spawnSyncImpl = spawnSync, createIo = createLiveDevelopmentApplyIo }) {
  const isProduction = env.AIRINGCAL_ENV === 'production'
  if (isProduction) {
    if (String(env.AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED ?? '') !== 'yes'
      || String(env.AIRINGCAL_DEPLOY_LIVE_CONFIRM ?? '') !== 'yes') {
      throw new Error('Production apply gates are not set; refusing to mutate')
    }
  }
  const io = createIo({ env, plan, spawnSyncImpl })
  const result = isProduction
    ? await runProductionApply({ plan, env, io })
    : await runDevelopmentApply({ plan, env, io })
  logFn(result.ok
    ? `Apply ${isProduction ? 'finished' : 'completed'}: ${(result.completed ?? []).join(' → ')}`
    : `Apply aborted: ${result.reason} (completed: ${(result.completed ?? []).join(', ')})`)
  return { result, io }
}

/**
 * Engine inputs the wizard must forward from the resolved source
 * environment: S3 credential overrides and the explicit writer-token
 * rotation id are read by the live adapters, and their own remediation
 * messages point at these variables (#195 review).
 */
const ENGINE_INPUT_KEYS = Object.freeze([
  'AIRINGCAL_S3_ACCESS_KEY_ID',
  'AIRINGCAL_S3_SECRET_ACCESS_KEY',
  'AIRINGCAL_S3_ENDPOINT',
  'AIRINGCAL_S3_REGION',
  'AIRINGCAL_WRITER_TOKEN_ROTATION_ID',
])

/**
 * Assemble the env handed to the apply runners. Interactive confirmation is
 * the ONLY place the production gates are synthesized; headless runs must
 * carry both documented gates themselves (never manufactured from the
 * wizard confirmation flag).
 */
export function resolveApplyEnvironment({ environment, headless, approved, wizardEnv, sourceEnv = {} }) {
  if (!approved) throw new Error('Apply is not authorized')
  const applyEnv = { ...wizardEnv }
  for (const key of ENGINE_INPUT_KEYS) {
    if (sourceEnv[key] !== undefined) applyEnv[key] = sourceEnv[key]
  }
  if (environment === 'production') {
    if (headless) {
      const authorized = String(sourceEnv.AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED ?? '') === 'yes'
      const liveConfirmed = String(sourceEnv.AIRINGCAL_DEPLOY_LIVE_CONFIRM ?? '') === 'yes'
      if (!authorized || !liveConfirmed) {
        throw new Error(
          'Headless production apply requires AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes and AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes ' +
          'in the environment (.env.production or shell); the wizard never synthesizes them non-interactively',
        )
      }
    }
    applyEnv.AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED = 'yes'
    applyEnv.AIRINGCAL_DEPLOY_LIVE_CONFIRM = 'yes'
  }
  return applyEnv
}

/**
 * First Full Sync orchestration (#195 P5): bounded, gate-scoped, always
 * cleans up. Verifies the remote branch head, opens ONLY the environment's
 * temporary gate, dispatches the existing workflow, waits for the run to pass
 * its in-job gate step then closes the gate, and monitors the run terminal.
 */

/**
 * #195 correction: classify a `gh api` read as ok/absent/error. A transport,
 * permission or API failure is NEVER treated as "safely absent".
 */
function classifyGhApiRead(result) {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  if (result?.status === 0) return 'ok'
  if (result?.status === 404 || /\bNot Found\b/i.test(text)) return 'absent'
  return 'error'
}

function readRemoteVariable(path, spawnSyncImpl) {
  const result = run('gh', ['api', path, '--jq', '.value'], {
    spawnSyncImpl,
    allowFailure: true,
  })
  const kind = classifyGhApiRead(result)
  const value = kind === 'ok' ? String(result.stdout).trim() : null
  return {
    kind,
    value,
    detail: kind === 'error'
      ? String(result.stderr || result.stdout || '').trim().slice(0, 300)
      : null,
  }
}

function readEnvironmentGate({ repo, environment, gateVariable, spawnSyncImpl }) {
  return readRemoteVariable(`repos/${repo}/environments/${environment}/variables/${gateVariable}`, spawnSyncImpl)
}

function readScheduleGate({ repo, spawnSyncImpl }) {
  return readRemoteVariable(`repos/${repo}/actions/variables/AIRINGCAL_WRITER_ENABLED`, spawnSyncImpl)
}

/** Set the gate and PROVE the readback; no receipt without evidence. */
async function setGateWithReadback({ repo, environment, gateVariable, value, spawnSyncImpl, log: logFn }) {
  const result = run('gh', [
    'variable', 'set', gateVariable, '--env', environment, '--repo', repo, '--body', value,
  ], { spawnSyncImpl, allowFailure: true })
  if (result.status !== 0) {
    throw new Error(
      `FAILED to set ${gateVariable}=${value} (${String(result.stderr || result.stdout || '').trim().slice(0, 200)}); ` +
      `RECOVERY: gh variable set ${gateVariable} --env ${environment} --repo ${repo} --body ${value}`,
    )
  }
  const readback = readEnvironmentGate({ repo, environment, gateVariable, spawnSyncImpl })
  if (readback.kind !== 'ok' || readback.value !== value) {
    throw new Error(
      `UNVERIFIED gate state for ${gateVariable} (readback ${readback.kind}:${readback.value ?? '-'}); ` +
      `HIGH PRIORITY: manually verify and set ${gateVariable}=${value} in GitHub environment ${environment} ` +
      `before any Writer dispatch (gh variable set ${gateVariable} --env ${environment} --repo ${repo} --body ${value})`,
    )
  }
  logFn(`Verified ${gateVariable}=${value} by remote readback.`)
  return readback
}

/** Restore a workflow we enabled and PROVE the disabled_manually state. */
async function restoreWorkflowWithReadback({ repo, workflowId, spawnSyncImpl, log: logFn }) {
  const result = run('gh', ['workflow', 'disable', workflowId, '--repo', repo], {
    spawnSyncImpl,
    allowFailure: true,
  })
  if (result.status !== 0) {
    throw new Error(
      `FAILED to disable workflow ${workflowId} (${String(result.stderr || result.stdout || '').trim().slice(0, 200)}); ` +
      `HIGH PRIORITY: gh workflow disable ${workflowId} --repo ${repo}`,
    )
  }
  const stateResult = run('gh', [
    'api', `repos/${repo}/actions/workflows/portable-writer.yml`, '--jq', '.state',
  ], { spawnSyncImpl, allowFailure: true })
  const state = stateResult.status === 0 ? String(stateResult.stdout).trim() : null
  if (state !== 'disabled_manually') {
    throw new Error(
      `UNVERIFIED workflow restoration (state ${state ?? 'unreadable'}); ` +
      `HIGH PRIORITY: gh workflow disable ${workflowId} --repo ${repo} and confirm disabled_manually`,
    )
  }
  logFn('Verified the Writer workflow was restored to disabled_manually.')
  return state
}
export async function runFirstSync({
  environment,
  branch = 'dev',
  expectedSha = null,
  spawnSyncImpl = spawnSync,
  log: logFn = log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 15_000,
  gateTimeoutMs = 15 * 60_000,
  runTimeoutMs = 120 * 60_000,
  now = () => Date.now(),
  repo = WIZARD_REPOSITORY,
  runId = null,
}) {
  const ghStrict = (args) => run('gh', args, { spawnSyncImpl })
  const gateVariable = gateVariableName(environment)
  const state = {
    runId: null,
    runUrl: null,
    headSha: null,
    conclusion: null,
    gateOpened: false,
    gateReadback: null,
    gateClosed: false,
    workflowEnabledByUs: false,
    workflowRestored: false,
    workflowReadback: null,
    cleanupVerified: false,
    recoveryAction: null,
  }
  let workflowId = null
  const cleanupErrors = []
  let primaryError = null
  try {
    ghStrict(['auth', 'status'])
    if (expectedSha) {
      const head = ghStrict(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']).stdout.trim()
      if (head !== expectedSha) {
        throw new Error(`Remote ${branch} head is ${head}, expected ${expectedSha}; refusing to dispatch an unverified ref`)
      }
    }
    // Resolve by FILE via the Actions API: `gh workflow list` hides
    // disabled_manually workflows from the default listing.
    const workflow = JSON.parse(ghStrict([
      'api', `repos/${repo}/actions/workflows/portable-writer.yml`, '--jq', '{id, state}',
    ]).stdout)
    if (!workflow?.id) throw new Error('portable-writer.yml not found in the repository')
    workflowId = String(workflow.id)
    const workflowState = String(workflow.state)

    // #195 correction: an unreadable schedule gate is NEVER "safely disabled".
    const schedule = readScheduleGate({ repo, spawnSyncImpl })
    if (schedule.kind === 'error') {
      throw new Error(
        `Refusing first sync: AIRINGCAL_WRITER_ENABLED is unreadable (${schedule.detail ?? 'API error'}); ` +
        'verify the repository variable manually before any dispatch',
      )
    }
    if (String(schedule.value ?? '').toLowerCase() === 'true') {
      throw new Error('Refusing first sync: the scheduled writer is enabled; disable AIRINGCAL_WRITER_ENABLED before initial acceptance')
    }

    // Single-flight: verify no Writer run is active before opening gates.
    const listRows = () => JSON.parse(ghStrict([
      'run', 'list', '--workflow', 'portable-writer.yml', '--limit', '20',
      '--json', 'databaseId,status,event,headSha,headBranch,url', '--repo', repo,
    ]).stdout)
    const before = listRows()
    const maxRunId = before.reduce((max, row) => Math.max(max, Number(row.databaseId) || 0), 0)
    const active = before.filter((row) => ['in_progress', 'queued', 'waiting', 'pending'].includes(String(row.status)))
    if (active.length > 0) {
      throw new Error(`Refusing first sync: active Writer run(s) ${active.map((r) => r.databaseId).join(', ')} (single-flight)`)
    }

    if (workflowState === 'disabled_manually') {
      ghStrict(['workflow', 'enable', workflowId, '--repo', repo])
      state.workflowEnabledByUs = true
      const enabled = ghStrict([
        'api', `repos/${repo}/actions/workflows/portable-writer.yml`, '--jq', '.state',
      ]).stdout.trim()
      if (enabled !== 'active') {
        throw new Error(`Workflow enable could not be confirmed (state ${enabled || 'unreadable'}); HIGH PRIORITY: check Actions permissions`)
      }
      logFn('Workflow was disabled manually; enabled for the authorized dispatch (schedule gate stays closed).')
    }

    await setGateWithReadback({ repo, environment, gateVariable, value: 'true', spawnSyncImpl, log: logFn })
    state.gateOpened = true
    state.gateReadback = 'true'
    logFn(`Opened and verified temporary gate ${gateVariable} for the ${environment} environment.`)

    ghStrict(['workflow', 'run', 'portable-writer.yml', '--ref', branch, '-f', `target=${environment}`, '-f', 'force_mode=full', '--repo', repo])

    // #195 correction: correlate by monotonic run id + event + ref/SHA, never
    // by a timestamp window. More than one new matching run is ambiguous.
    let runRow = null
    for (let attempt = 0; attempt < 20 && !runRow; attempt += 1) {
      const candidates = listRows().filter((row) => {
        if (Number(row.databaseId) <= maxRunId) return false
        if (String(row.event) !== 'workflow_dispatch') return false
        if (expectedSha && String(row.headSha) !== expectedSha) return false
        if (String(row.headBranch ?? '') !== branch) return false
        if (runId && String(row.databaseId) !== String(runId)) return false
        return true
      })
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous dispatch: new runs ${candidates.map((r) => r.databaseId).join(', ')} match; ` +
          'refusing to select an unrelated run. Inspect the Actions tab and re-run with explicit run id.',
        )
      }
      if (candidates.length === 1) {
        const verified = JSON.parse(ghStrict([
          'run', 'view', String(candidates[0].databaseId),
          '--json', 'databaseId,headSha,headBranch,status,url', '--repo', repo,
        ]).stdout)
        if (String(verified.databaseId) !== String(candidates[0].databaseId)
          || (expectedSha && String(verified.headSha) !== expectedSha)
          || String(verified.headBranch ?? '') !== branch) {
          throw new Error('Dispatched run identity disagrees with the run view; refusing to continue')
        }
        runRow = { ...candidates[0], ...verified }
        break
      }
      await sleep(pollMs)
    }
    if (!runRow) throw new Error('Dispatch was accepted but no uniquely identifiable run appeared; check the Actions tab')
    state.runId = String(runRow.databaseId)
    state.runUrl = runRow.url ?? null
    state.headSha = runRow.headSha ?? null
    logFn(`Correlated dispatch to run ${state.runId}${state.runUrl ? ` (${state.runUrl})` : ''}`)

    const pattern = gateStepPattern(environment)
    const gateDeadline = now() + gateTimeoutMs
    let gateVerdict = 'pending'
    while (now() < gateDeadline) {
      const view = JSON.parse(ghStrict(['run', 'view', state.runId, '--json', 'status,conclusion,jobs', '--repo', repo]).stdout)
      gateVerdict = gateStepVerdict(view.jobs, pattern)
      if (gateVerdict === 'passed') {
        await setGateWithReadback({ repo, environment, gateVariable, value: 'false', spawnSyncImpl, log: logFn })
        state.gateClosed = true
        state.gateReadback = 'false'
        logFn(`Run passed its ${environment} gate step; temporary gate closed and verified.`)
        break
      }
      if (gateVerdict === 'failed' || view.status === 'completed') break
      await sleep(pollMs)
    }
    const runDeadline = now() + runTimeoutMs
    let view = null
    while (now() < runDeadline) {
      view = JSON.parse(ghStrict(['run', 'view', state.runId, '--json', 'status,conclusion', '--repo', repo]).stdout)
      if (view.status === 'completed') break
      await sleep(pollMs)
    }
    state.conclusion = view?.conclusion ?? null
    if (gateVerdict !== 'passed') {
      throw new Error(`First sync run did not pass its gate step (verdict ${gateVerdict}, conclusion ${state.conclusion})`)
    }
    if (state.conclusion !== 'success') {
      throw new Error(`First sync run concluded ${state.conclusion}`)
    }
  } catch (error) {
    primaryError = error
  }

  // Cleanup ALWAYS runs with strict status checks and readback. A failed or
  // unverifiable cleanup is reported loudly — never converted into a receipt.
  if (!state.gateClosed) {
    try {
      await setGateWithReadback({ repo, environment, gateVariable, value: 'false', spawnSyncImpl, log: logFn })
      state.gateClosed = true
      state.gateReadback = 'false'
    } catch (error) { cleanupErrors.push(error) }
  }
  if (state.workflowEnabledByUs && !state.workflowRestored) {
    try {
      state.workflowReadback = await restoreWorkflowWithReadback({ repo, workflowId, spawnSyncImpl, log: logFn })
      state.workflowRestored = true
    } catch (error) { cleanupErrors.push(error) }
  }
  if (cleanupErrors.length > 0) {
    state.cleanupVerified = false
    state.recoveryAction = [
      'HIGH PRIORITY — remote cleanup UNVERIFIED:',
      ...cleanupErrors.map((error) => `  ${error.message}`),
      `  Inspect GitHub environment ${environment} and Actions workflow ${repo}; do not dispatch again until confirmed.`,
    ].join('\n')
    const error = new Error(state.recoveryAction)
    error.cleanupErrors = cleanupErrors
    error.state = state
    if (primaryError) error.cause = primaryError
    throw error
  }
  state.cleanupVerified = true
  if (primaryError) {
    primaryError.state = state
    throw primaryError
  }
  return state
}

/** Read-only diagnostics: no mutations, secrets never printed. */
export async function runDoctor({ environment, spawnSyncImpl = spawnSync, log: logFn = log, env = {} }) {
  const report = { environment, checks: [] }
  const push = (name, status, detail) => {
    report.checks.push({ name, status, detail })
    logFn(`${status === 'ok' ? '✓' : status === 'warn' ? '!' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  const gh = (args) => run('gh', args, { spawnSyncImpl, allowFailure: true })
  const auth = gh(['auth', 'status'])
  push('gh auth', auth.status === 0 ? 'ok' : 'fail', auth.status === 0 ? undefined : 'run gh auth login')
  const workflow = gh(['api', `repos/${WIZARD_REPOSITORY}/actions/workflows/portable-writer.yml`, '--jq', '{id, state}'])
  if (workflow.status === 0) {
    const state = String(JSON.parse(workflow.stdout).state ?? 'missing')
    push('writer workflow', state === 'disabled_manually' ? 'warn' : 'ok', state)
  } else push('writer workflow', 'fail', 'cannot read the workflow state')

  // #195 correction: distinguish absent/false (closed) from unreadable.
  const gate = readEnvironmentGate({
    repo: WIZARD_REPOSITORY,
    environment,
    gateVariable: gateVariableName(environment),
    spawnSyncImpl,
  })
  if (gate.kind === 'error') {
    push(`${environment} gate`, 'fail', `UNREADABLE (${gate.detail ?? 'API error'}); do not assume it is closed`)
  } else if (gate.kind === 'absent') {
    push(`${environment} gate`, 'ok', 'confirmed absent (closed by GitHub default)')
  } else {
    push(`${environment} gate`, String(gate.value).toLowerCase() === 'true' ? 'warn' : 'ok',
      `verified value ${gate.value}`)
  }
  const schedule = readScheduleGate({ repo: WIZARD_REPOSITORY, spawnSyncImpl })
  if (schedule.kind === 'error') {
    push('schedule gate', 'fail', `UNREADABLE (${schedule.detail ?? 'API error'}); never treat as disabled`)
  } else if (schedule.kind === 'absent') {
    push('schedule gate', 'ok', 'confirmed absent (cron gated off)')
  } else {
    push('schedule gate', String(schedule.value).toLowerCase() === 'true' ? 'warn' : 'ok',
      `verified value ${schedule.value}`)
  }
  const runs = gh(['run', 'list', '--workflow', 'portable-writer.yml', '--limit', '3', '--json', 'databaseId,status,conclusion,headSha', '--repo', WIZARD_REPOSITORY])
  if (runs.status === 0) {
    const rows = JSON.parse(runs.stdout)
    const active = rows.filter((row) => ['in_progress', 'queued', 'waiting', 'pending'].includes(String(row.status)))
    if (active.length > 0) push('active writer runs', 'warn', active.map((r) => r.databaseId).join(', '))
    for (const row of rows) {
      push(`recent run ${row.databaseId}`, row.status === 'completed' && row.conclusion === 'success' ? 'ok' : 'warn',
        `${row.status}/${row.conclusion ?? '-'} @ ${String(row.headSha ?? '').slice(0, 8)}`)
    }
  } else push('active writer runs', 'fail', 'cannot list workflow runs')
  if (env.AIRINGCAL_PUBLIC_BASE_URL) {
    try {
      const response = await fetch(`${String(env.AIRINGCAL_PUBLIC_BASE_URL).replace(/\/+$/, '')}/public/current-release.json`, {
        signal: AbortSignal.timeout(10_000),
      })
      push('public pointer', response.ok ? 'ok' : 'warn', `HTTP ${response.status}`)
    } catch (error) {
      push('public pointer', 'warn', error.message?.slice(0, 80))
    }
  }
  return report
}

/** Run the canonical live verifier with the derived S3 credentials (env only). */
export function runVerifier({ base, bucket, accountId, s3, spawnSyncImpl = spawnSync, log: logFn = log }) {
  const result = run('node', ['scripts/v3-ship-verify.mjs', '--base', base, '--bucket', bucket, '--json'], {
    spawnSyncImpl,
    env: {
      ...process.env,
      AIRINGCAL_S3_ACCESS_KEY_ID: s3.accessKeyId,
      AIRINGCAL_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
      AIRINGCAL_S3_ACCOUNT_ID: accountId,
    },
    allowFailure: true,
  })
  let parsed = null
  try { parsed = JSON.parse(result.stdout) } catch { /* reported below */ }
  if (!parsed) {
    logFn(`Verifier did not emit JSON (exit ${result.status}): ${String(result.stderr).slice(0, 300)}`)
    return { pass: false, checks: [], error: 'verifier_output_invalid' }
  }
  const passCount = parsed.checks.filter((check) => check.pass === true).length
  logFn(parsed.pass
    ? `Live verification PASSED (${passCount}/${parsed.checks.length} checks)`
    : `Live verification FAILED: ${(parsed.failed ?? []).join(', ')}`)
  return parsed
}

export function writeInventory({ environment, inventory, secrets = [], baseDir = ROOT }) {
  // Value-level leak check with the run's actual credentials plus the
  // structural token-shaped check inside assertInventorySanitized.
  assertInventorySanitized(inventory, secrets)
  const dir = join(baseDir, INVENTORY_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `inventory.${environment}.json`)
  writeFileSync(path, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 })
  return path
}

/** Headless resolution: the same environment object from env/dotenv. */
export function loadHeadlessEnvironment({ environment, dotenvPath, processEnv = process.env } = {}) {
  const envName = String(environment ?? processEnv.AIRINGCAL_ENV ?? '').trim().toLowerCase()
  if (!WIZARD_ENVIRONMENTS.includes(envName)) {
    throw new Error('Headless setup needs AIRINGCAL_ENV=production|development')
  }
  const path = resolve(resolveDeployDotenvPath({ envName, dotenvPathEnv: dotenvPath ?? processEnv.AIRINGCAL_DOTENV_PATH }))
  if (envName === 'production') return { env: loadProductionDeployEnv(path, processEnv), dotenvPath: path }
  return { env: loadDotEnvFile(path, processEnv), dotenvPath: path }
}


/**
 * #195 correction: when automatic scoped Writer provisioning is unsupported,
 * interactive runs accept an independently scoped R2 credential through
 * genuinely masked prompts — no dotenv editing. Headless keeps its documented
 * AIRINGCAL_S3_* overrides.
 */
export async function askS3CredentialFallback(io) {
  const accessKeyId = (await askSecret('Cloudflare R2 S3 Access Key ID (operator-supplied)', io)).trim()
  const secretAccessKey = (await askSecret('Cloudflare R2 S3 Secret Access Key', io)).trim()
  if (!accessKeyId || !secretAccessKey) {
    throw new WizardAbort('S3 credential fallback cancelled: both values are required')
  }
  return { AIRINGCAL_S3_ACCESS_KEY_ID: accessKeyId, AIRINGCAL_S3_SECRET_ACCESS_KEY: secretAccessKey }
}

async function collectCredentials({ ui, docs, fetchImpl, env, initial = {} }) {
  let cloudflareToken = initial.cloudflareToken ?? ''
  let bangumiToken = initial.bangumiToken ?? ''
  let validation = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!cloudflareToken) {
      credentialSection(ui, {
        title: 'Cloudflare API Token',
        purpose: 'Needed to create and manage the Worker and the private R2 bucket in your Cloudflare account.',
        links: credentialLinks('cloudflare', docs),
      })
      cloudflareToken = await ui.password({
        message: 'Paste your Cloudflare API Token (input is masked)',
        validate: (value) => (String(value ?? '').trim() ? undefined : 'A Cloudflare API Token is required'),
      })
    }
    if (!bangumiToken) {
      credentialSection(ui, {
        title: 'Bangumi Personal Access Token',
        purpose: 'Needed to read your anime collections and episode progress for synchronization.',
        links: credentialLinks('bangumi', docs),
      })
      bangumiToken = await ui.password({
        message: 'Paste your Bangumi Personal Access Token (input is masked)',
        validate: (value) => (String(value ?? '').trim() ? undefined : 'A Bangumi Personal Access Token is required'),
      })
    }
    ui.log.step('Validate API Credentials')
    validation = await validateCredentials({
      fetchImpl,
      cloudflareToken,
      bangumiToken,
      log: (line) => ui.log.info(line),
    })
    if (validation.ok) {
      ui.log.success('API credentials validated (read-only capability checks).')
      return { cloudflareToken, bangumiToken, validation }
    }
    ui.log.error(`Credential validation failed: ${validation.blocking.join(', ')}`)
    const action = await ui.select({
      message: 'How do you want to continue?',
      options: [
        { value: 'cloudflare', label: 'Re-enter Cloudflare API Token' },
        { value: 'bangumi', label: 'Re-enter Bangumi Personal Access Token' },
        { value: 'retry', label: 'Retry Validation' },
        { value: 'menu', label: 'Return to Main Menu' },
        { value: 'cancel', label: 'Cancel' },
      ],
      initialValue: 'retry',
    })
    if (action === 'cancel') throw new WizardAbort('Installation cancelled during credential validation')
    if (action === 'menu') throw new WizardAbort('Returned to main menu')
    if (action === 'cloudflare') cloudflareToken = ''
    if (action === 'bangumi') bangumiToken = ''
  }
  throw new WizardAbort('Credential validation did not succeed after repeated attempts')
}

function renderReview(ui, { environment, account, identity, workersSubdomain, validation, customDomain, zoneName, plan }) {
  const v = (id) => validation?.checks.find((entry) => entry.id === id)?.state ?? 'NOT_VERIFIED'
  const lines = [
    `Installation: ${plan?.writerEnabled === false ? 'New Installation (owned resources are reused)' : 'Installation'}`,
    `Environment: ${environment === 'production' ? 'Production' : 'Development'}`,
    '',
    'Credentials:',
    `  Cloudflare API Token: ${v('cloudflare.token')}`,
    `  Bangumi Personal Access Token: ${v('bangumi.token')}`,
    `  Bangumi identity: ${identity ? `${identity.username} (id ${identity.userId})` : 'not detected'}`,
    `  Writer credential: ${plan?.env === 'production' ? 'bucket-scoped Writer token (created after bucket ownership proof), masked S3 fallback available' : 'scoped Writer token / derived engine credential'}`,
    '',
    'Cloudflare Deployment:',
    `  Account: ${account ? `${account.name} (${account.id})` : 'not selected'}`,
    `  Worker: ${plan?.cloudflareWorkerName ?? '-'}`,
    `  R2 Bucket: ${plan?.bucket ?? '-'} (private; no anonymous object access)`,
    `  workers.dev subdomain: ${workersSubdomain ?? 'not detected'}`,
    '',
    'Providers:',
    '  Cloudflare: enabled',
    '  EdgeOne: disabled (not part of this installation)',
    '',
    'Domain:',
    `  ${customDomain ? `Custom Domain: ${customDomain}${zoneName ? ` (zone ${zoneName})` : ''}` : 'Default workers.dev URL (no DNS changes)'}`,
    `  Public URL: ${plan?.publicBaseUrl ?? plan?.workerOrigin ?? '-'}`,
    '',
    'Data Synchronization:',
    '  Full personal anime progress (collections + episode states) via GitHub Actions',
    `  GitHub Environment: ${plan?.env ?? environment}`,
    '  First Full Sync: separate explicit authorization',
  ]
  ui.note(lines.join('\n'), 'Configuration Review')
}

async function installFlow({
  io,
  env = {},
  fetchImpl,
  spawnSyncImpl,
  log: logFn,
  requestedEnvironment,
  headless,
  hooks = {},
  ui: injectedUi = null,
}) {
  // #205 QA-001: test-only adapter injection used by the committed PTY harness.
  spawnSyncImpl = hooks.spawnSyncImpl ?? spawnSyncImpl
  fetchImpl = hooks.fetchImpl ?? fetchImpl
  const ui = injectedUi ?? hooks.ui ?? createUi({ io, env })
  const docs = resolveDocumentation(env)
  if (hooks.preflight) await hooks.preflight({ spawnSyncImpl })
  else await preflight({ spawnSyncImpl })

  let environment = requestedEnvironment
  let resolvedEnv = env
  let dotenvPath = null
  let cloudflareToken = ''
  let bangumiToken = ''
  let validation = null
  let discovery = null
  let customDomain = ''
  let zoneId = ''
  let zoneName = ''

  if (headless) {
    environment = environment ?? String(env.AIRINGCAL_ENV ?? '').trim().toLowerCase()
    if (!WIZARD_ENVIRONMENTS.includes(environment)) {
      throw new Error('Headless setup needs --environment production|development')
    }
    const loaded = loadHeadlessEnvironment({ environment })
    resolvedEnv = loaded.env
    dotenvPath = loaded.dotenvPath
    const missingTokens = ['AIRINGCAL_CLOUDFLARE_API_TOKEN', 'AIRINGCAL_BANGUMI_TOKEN']
      .filter((key) => !String(resolvedEnv[key] ?? '').trim())
    if (missingTokens.length > 0) {
      throw new Error(`Headless setup needs ${missingTokens.join(', ')} in the environment/dotenv`)
    }
    const tokens = await resolveTokens({ io, env: resolvedEnv, log: logFn })
    cloudflareToken = tokens.cloudflareToken
    bangumiToken = tokens.bangumiToken
  } else {
    ui.intro('AiringCal Setup')
    environment = environment ?? await ui.select({
      message: 'Environment',
      options: ENVIRONMENT_OPTIONS.map((option) => ({ ...option })),
      initialValue: 'production',
    })
    if (environment === 'development') {
      ui.note(
        'Selecting Development can change the existing Development deployment configuration in this repository. ' +
        'A separate Cloudflare account does not isolate GitHub Environment state.',
        'Development Environment',
      )
    }
    const collected = await collectCredentials({ ui, docs, fetchImpl, env })
    cloudflareToken = collected.cloudflareToken
    bangumiToken = collected.bangumiToken
    validation = collected.validation
  }

  let approved = false
  let applyEnv = null
  let executionPlan = null
  let dry = null
  for (let round = 0; round < 6 && !approved; round += 1) {
    discovery = await discoverIdentity({
      fetchImpl,
      cloudflareToken,
      bangumiToken,
      io,
      env: resolvedEnv,
      log: logFn,
      prompts: ui.prompts,
    })
    if (!headless) {
      const hostnameHint = String(resolvedEnv.AIRINGCAL_WORKER_CUSTOM_DOMAIN ?? customDomain ?? '').trim()
      const zoneHint = String(resolvedEnv.AIRINGCAL_ZONE_ID ?? zoneId ?? '').trim()
      const domain = hostnameHint
        ? await planCustomDomain({
            fetchImpl,
            cloudflareToken,
            account: discovery.account,
            io,
            log: logFn,
            assume: true,
            hostnameHint,
            zoneHint,
            allowTakeover: String(resolvedEnv.AIRINGCAL_ALLOW_CUSTOM_DOMAIN_TAKEOVER ?? '') === 'yes',
            prompts: ui.prompts,
          })
        : await planCustomDomain({
            fetchImpl,
            cloudflareToken,
            account: discovery.account,
            io,
            log: logFn,
            prompts: ui.prompts,
            allowTakeover: String(resolvedEnv.AIRINGCAL_ALLOW_CUSTOM_DOMAIN_TAKEOVER ?? '') === 'yes',
          })
      customDomain = String(hostnameHint || domain.customDomain || '').trim()
      zoneId = String(zoneHint || domain.zoneId || '').trim()
    }
    const wizardEnv = wizardEnvironment({
      environment,
      cloudflareToken,
      accountId: discovery.account.id,
      workersSubdomain: discovery.workersSubdomain,
      bangumiToken,
      identity: discovery.identity,
      usersJson: discovery.usersJson,
      customDomain,
      zoneId,
      dotenvPath,
    })
    dry = buildPlanForEnvironment(wizardEnv, { mode: 'dry-run' })
    if (!headless) {
      renderReview(ui, {
        environment,
        account: discovery.account,
        identity: discovery.identity,
        workersSubdomain: discovery.workersSubdomain,
        validation,
        customDomain,
        zoneName,
        plan: dry.plan,
      })
      if (String(env.AIRINGCAL_WIZARD_VERBOSE ?? '') === 'yes') ui.note(formatPlan(dry.plan), 'Detailed Execution Plan')
      const action = await ui.select({
        message: 'Review Configuration',
        options: [
          { value: 'install', label: 'Confirm and Install' },
          { value: 'credentials', label: 'Re-enter Credentials' },
          { value: 'domain', label: 'Edit Domain Configuration' },
          { value: 'environment', label: 'Edit Environment' },
          { value: 'cancel', label: 'Cancel' },
        ],
        initialValue: 'install',
      })
      if (action === 'cancel') {
        ui.cancel('Installation cancelled; nothing was mutated.')
        return { applied: false, verdict: 'CANCELLED', reason: 'installation cancelled at configuration review' }
      }
      if (action === 'credentials') {
        const collected = await collectCredentials({ ui, docs, fetchImpl, env, initial: { cloudflareToken, bangumiToken } })
        cloudflareToken = collected.cloudflareToken
        bangumiToken = collected.bangumiToken
        validation = collected.validation
        continue
      }
      if (action === 'domain') { customDomain = ''; zoneId = ''; zoneName = ''; continue }
      if (action === 'environment') {
        environment = await ui.select({
          message: 'Environment',
          options: ENVIRONMENT_OPTIONS.map((option) => ({ ...option })),
          initialValue: environment,
        })
        continue
      }
      approved = await ui.confirm({ message: `Install AiringCal in ${environment === 'production' ? 'Production' : 'Development'} now?`, initialValue: true })
      if (!approved) {
        ui.cancel('Nothing was applied.')
        return { applied: false, verdict: 'CANCELLED', reason: 'installation not confirmed' }
      }
    } else {
      approved = String(resolvedEnv.AIRINGCAL_WIZARD_CONFIRM ?? '') === 'yes'
      if (!approved) {
        logFn('Plan not applied; nothing was mutated. Re-run `pnpm run setup` when ready.')
        return { applied: false, verdict: 'CANCELLED', reason: 'deployment plan was not approved' }
      }
    }
  }
  if (!approved) throw new Error('Configuration review did not reach confirmation')

  applyEnv = resolveApplyEnvironment({
    environment,
    headless,
    approved,
    wizardEnv: wizardEnvironment({
      environment,
      cloudflareToken,
      accountId: discovery.account.id,
      workersSubdomain: discovery.workersSubdomain,
      bangumiToken,
      identity: discovery.identity,
      usersJson: discovery.usersJson,
      customDomain,
      zoneId,
      dotenvPath,
    }),
    sourceEnv: resolvedEnv,
  })

  // #205 BUG-001: derive the ACTUAL authorized apply-mode plan from the same
  // approved configuration, and prove it matches what the Owner reviewed.
  const applyDerived = buildPlanForEnvironment(applyEnv, { mode: 'apply' })
  assertApplyPlanMatchesReview(dry.plan, applyDerived.plan)
  executionPlan = applyDerived.plan

  const finalize = ({
    verdict,
    reason = null,
    sync = null,
    syncError = null,
    verification = null,
    verificationError = null,
  }) => {
    const inventory = buildInventory({
      plan: executionPlan,
      account: discovery.account,
      identity: discovery.identity,
      environment,
      customDomain,
      buildSha: resolveGitSha(spawnSyncImpl),
      deployedAt: new Date().toISOString(),
      writerCredential: s3,
      verification: verification ? { pass: verification.pass, failed: verification.failed ?? [] } : null,
      verdict,
      mutationReceipts: applyReceipts.map((receipt) => ({
        status: receipt.ok ? 'applied' : 'aborted',
        completed: receipt.completed ?? [],
        mutationsExecuted: receipt.mutationsExecuted ?? [],
        reason: receipt.reason ?? null,
      })),
    })
    let inventoryPath = null
    try {
      inventoryPath = writeInventory({
        environment,
        inventory,
        secrets: [cloudflareToken, bangumiToken, s3?.secretAccessKey ?? ''].filter(Boolean),
      })
    } catch (error) { logFn(`Inventory could not be persisted: ${error.message}`) }
    if (!headless) ui.outro(`${verdict}${reason ? ` — ${reason}` : ''}`)
    logFn(
      `\n${verdict}. Public URL: ${executionPlan.publicBaseUrl ?? executionPlan.workerOrigin}` +
      `${inventoryPath ? `\nInventory: ${inventoryPath}` : ''}${reason ? `\nReason: ${reason}` : ''}`,
    )
    return {
      applied: result.ok === true,
      verdict,
      reason,
      result,
      applyReceipts,
      sync,
      syncError,
      verification,
      verificationError,
      inventory,
      inventoryPath,
    }
  }

  const applyOptions = {
    log: logFn,
    spawnSyncImpl,
    ...(hooks.createApplyIo ? { createIo: hooks.createApplyIo } : {}),
  }
  const spinner = ui.spinner()
  spinner.start('Applying approved infrastructure plan')
  let { result, io: liveIo } = await applyPlan({ env: applyEnv, plan: executionPlan, ...applyOptions })
  spinner.stop(result.ok ? 'Infrastructure applied' : 'Infrastructure apply aborted')
  const applyReceipts = [result]
  let s3 = liveIo.s3Credentials?.() ?? null
  if (!result.ok && !headless && Array.isArray(result.missingScopes) && result.missingScopes.length > 0) {
    logFn(
      `Automatic Writer credential provisioning was not available (${result.reason}). ` +
      `Completed effects: ${(result.completed ?? []).join(' → ') || 'none'}.`,
    )
    const confirmed = await ui.confirm({
      message: 'Supply an independently scoped R2 credential now (masked input)?',
      initialValue: true,
    })
    if (!confirmed) return finalize({ verdict: 'DEPLOY_FAILED', reason: 'masked credential fallback declined after a partial apply' })
    const accessKeyId = (await ui.password({ message: 'Cloudflare R2 S3 Access Key ID (masked)' })).trim()
    const secretAccessKey = (await ui.password({ message: 'Cloudflare R2 S3 Secret Access Key (masked)' })).trim()
    if (!accessKeyId || !secretAccessKey) throw new WizardAbort('S3 credential fallback cancelled: both values are required')
    const fallback = { AIRINGCAL_S3_ACCESS_KEY_ID: accessKeyId, AIRINGCAL_S3_SECRET_ACCESS_KEY: secretAccessKey }
    spinner.start('Retrying the approved apply with the supplied credential')
    const retried = await applyPlan({ env: { ...applyEnv, ...fallback }, plan: executionPlan, ...applyOptions })
    spinner.stop(retried.result.ok ? 'Infrastructure applied' : 'Infrastructure apply aborted')
    result = retried.result
    liveIo = retried.io
    applyReceipts.push(result)
    s3 = retried.io.s3Credentials?.() ?? null
  }
  if (!result.ok) return finalize({ verdict: 'DEPLOY_FAILED', reason: result.reason ?? 'apply aborted' })

  let wantSync
  if (headless) {
    wantSync = String(resolvedEnv.AIRINGCAL_WIZARD_FIRST_SYNC ?? '') === 'yes'
  } else {
    wantSync = await ui.confirm({ message: 'Run the First Full Sync now (GitHub Actions, separate authorization)?', initialValue: true })
    if (wantSync) {
      const confirmed = await ui.confirm({
        message: 'Dispatch the Writer for the first full synchronization? A temporary gate is opened and closed automatically.',
        initialValue: true,
      })
      if (!confirmed) {
        wantSync = false
        ui.log.warn('First Full Sync declined; the deployment is intentionally uninitialized (AWAITING_FIRST_SYNC).')
      }
    }
  }
  let sync = null
  let syncError = null
  if (wantSync) {
    try {
      const syncRunner = hooks.syncRunner ?? runFirstSync
      const syncSpinner = ui.spinner()
      syncSpinner.start('Dispatching the First Full Sync (gates are opened, verified and closed automatically)')
      sync = await syncRunner({
        environment,
        expectedSha: resolveGitSha(spawnSyncImpl),
        spawnSyncImpl,
        log: logFn,
      })
      syncSpinner.stop('First Full Sync completed')
    } catch (error) {
      syncError = error
      ui.log.error(`First Full Sync failed: ${error.message?.slice(0, 400) ?? String(error)}`)
    }
  }
  let verification = null
  let verificationError = null
  if (s3 && sync) {
    try {
      const verifier = hooks.verifier ?? runVerifier
      const verifySpinner = ui.spinner()
      verifySpinner.start('Verifying the live deployment')
      verification = verifier({
        base: executionPlan.workerOrigin,
        bucket: executionPlan.bucket,
        accountId: discovery.account.id,
        s3,
        spawnSyncImpl,
        log: logFn,
      })
      verifySpinner.stop(verification?.pass === true ? 'Live verification passed' : 'Live verification failed')
    } catch (error) {
      verificationError = error
    }
  }
  const { verdict, reason } = computeVerdict({
    applied: result.ok === true,
    wantSync,
    headless,
    sync,
    syncError,
    verification,
    verificationError,
    applyReason: result.reason ?? null,
  })
  return finalize({ verdict, reason, sync, syncError, verification, verificationError })
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io ?? { input: process.stdin, output: process.stderr }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync
  const logFn = deps.log ?? log
  const env = deps.env ?? process.env
  const ui = deps.ui ?? createUi({ io, env })
  // #205 QA-001: a committed PTY acceptance harness injects deterministic
  // provider/command adapters through this env-only hook. Normal runs never
  // set it; all gate/verdict logic stays real.
  let hooks = deps.hooks ?? {}
  if (!deps.hooks && env.AIRINGCAL_WIZARD_TEST_HOOKS) {
    const loaded = await import(new URL(env.AIRINGCAL_WIZARD_TEST_HOOKS, `file://${ROOT}/`).href)
    hooks = loaded.default ?? loaded
  }
  const args = {
    mode: 'menu',
    headless: argv.includes('--headless'),
    environment: undefined,
    doctor: argv.includes('--doctor'),
    sync: argv.includes('--sync'),
  }
  const envIndex = argv.indexOf('--environment')
  if (envIndex !== -1) args.environment = argv[envIndex + 1]
  try {
    if (args.doctor) {
      const report = await runDoctor({ environment: args.environment ?? 'production', spawnSyncImpl, log: logFn, env })
      return { ok: report.checks.every((check) => check.status !== 'fail'), report }
    }
    if (args.sync) {
      if (!args.headless) {
        const confirmed = await ui.confirm({ message: 'Dispatch the First Full Sync now?', initialValue: false })
        if (!confirmed) throw new WizardAbort('Sync not authorized')
      } else if (String(env.AIRINGCAL_WIZARD_SYNC_AUTHORIZED ?? '') !== 'yes') {
        throw new Error(
          'Non-interactive first sync requires AIRINGCAL_WIZARD_SYNC_AUTHORIZED=yes in the environment; ' +
          'this is a separate authorization from the apply gates',
        )
      }
      const environment = args.environment ?? (args.headless ? env.AIRINGCAL_ENV : 'production')
      const syncResult = await runFirstSync({
        environment,
        expectedSha: resolveGitSha(spawnSyncImpl),
        spawnSyncImpl,
        log: logFn,
      })
      return { ok: true, sync: syncResult }
    }
    if (args.headless) {
      const result = await installFlow({ io, env, fetchImpl, spawnSyncImpl, log: logFn, requestedEnvironment: args.environment, headless: true, hooks, ui })
      return { ok: ['READY', 'DEPLOYED', 'AWAITING_FIRST_SYNC', 'CANCELLED'].includes(result.verdict), verdict: result.verdict, result }
    }
    const choice = await ui.select({
      message: 'AiringCal Setup',
      options: [
        { value: 'install', label: 'Install or Update', hint: 'two masked tokens, review, apply, First Full Sync' },
        { value: 'validate', label: 'Validate API Credentials', hint: 'read-only permission preflight' },
        { value: 'doctor', label: 'Doctor', hint: 'read-only gates, workflows and recent runs' },
        { value: 'exit', label: 'Exit' },
      ],
      initialValue: 'install',
    })
    if (choice === 'exit') return { ok: true, exit: true }
    if (choice === 'doctor') {
      const report = await runDoctor({ environment: 'production', spawnSyncImpl, log: logFn, env })
      return { ok: report.checks.every((check) => check.status !== 'fail'), report }
    }
    if (choice === 'validate') {
      const docs = resolveDocumentation(env)
      let cloudflareToken = String(env.AIRINGCAL_CLOUDFLARE_API_TOKEN ?? '').trim()
      let bangumiToken = String(env.AIRINGCAL_BANGUMI_TOKEN ?? '').trim()
      if (!cloudflareToken) {
        credentialSection(ui, { title: 'Cloudflare API Token', purpose: 'Validated read-only; nothing is created or changed.', links: credentialLinks('cloudflare', docs) })
        cloudflareToken = await ui.password({ message: 'Paste your Cloudflare API Token (masked)' })
      }
      if (!bangumiToken) {
        credentialSection(ui, { title: 'Bangumi Personal Access Token', purpose: 'Validated read-only against your own collections.', links: credentialLinks('bangumi', docs) })
        bangumiToken = await ui.password({ message: 'Paste your Bangumi Personal Access Token (masked)' })
      }
      const validation = await validateCredentials({ fetchImpl, cloudflareToken, bangumiToken, log: (line) => logFn(line) })
      return { ok: validation.ok, validation }
    }
    const result = await installFlow({ io, env, fetchImpl, spawnSyncImpl, log: logFn, requestedEnvironment: args.environment, headless: false, hooks, ui })
    return { ok: ['READY', 'DEPLOYED', 'AWAITING_FIRST_SYNC', 'CANCELLED'].includes(result.verdict), verdict: result.verdict, result }
  } catch (error) {
    if (error instanceof WizardAbort || error instanceof IdentityError) {
      logFn(`\nStopped: ${error.message}`)
      return { ok: false, aborted: true, code: error.code ?? 'WIZARD_ABORT', message: error.message }
    }
    logFn(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: String(error?.message ?? error) }
  }
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().then((result) => {
    process.exitCode = result.ok ? 0 : 1
  })
}
