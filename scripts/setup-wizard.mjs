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
import {
  INVENTORY_DIR,
  WIZARD_ENVIRONMENTS,
  WIZARD_REPOSITORY,
  assertInventorySanitized,
  buildInventory,
  chooseAccount,
  formatPlan,
  gateStepPattern,
  gateVariableName,
  gateStepVerdict,
  wizardEnvironment,
} from './setup-wizard-lib.mjs'

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
export async function resolveTokens({ io, env = {}, log: logFn = log }) {
  let cloudflareToken = String(env.AIRINGCAL_CLOUDFLARE_API_TOKEN ?? '').trim()
  let bangumiToken = String(env.AIRINGCAL_BANGUMI_TOKEN ?? '').trim()
  if (cloudflareToken) logFn('Using AIRINGCAL_CLOUDFLARE_API_TOKEN from the environment (in-memory).')
  else cloudflareToken = await askSecret('Cloudflare API token (R2 + Workers Scripts write)', io)
  if (bangumiToken) logFn('Using AIRINGCAL_BANGUMI_TOKEN from the environment (in-memory).')
  else bangumiToken = await askSecret('Bangumi personal access token', io)
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
      account = await askSelect(
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
}) {
  const wantsCustom =
    assume ?? (await askConfirm('Attach a custom domain to the Worker? (default: workers.dev URL only)', io))
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
    zone = await askSelect(
      'Select the zone for the custom domain',
      zones.map((entry) => ({ title: entry.name, hint: entry.status, value: entry })),
      io,
    )
  }
  const hostname = hostnameHint
    ? String(hostnameHint).trim().toLowerCase()
    : await askText(`Hostname under ${zone.name} (e.g. anime.${zone.name})`, io, {
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
      const takeOver = await askConfirm(
        `DNS name ${hostname} is already in use. Bind this Worker to it anyway (Cloudflare will replace the record)?`,
        io,
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
  const gh = (args, options = {}) => run('gh', args, { spawnSyncImpl, ...options })
  const gateVariable = gateVariableName(environment)
  const state = {
    runId: null,
    runUrl: null,
    headSha: null,
    conclusion: null,
    gateOpened: false,
    gateClosed: false,
    workflowEnabledByUs: false,
    workflowRestored: false,
  }
  let workflowState = null
  let workflowId = null
  try {
    gh(['auth', 'status'])
    if (expectedSha) {
      const head = gh(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']).stdout.trim()
      if (head !== expectedSha) {
        throw new Error(`Remote ${branch} head is ${head}, expected ${expectedSha}; refusing to dispatch an unverified ref`)
      }
    }
    // Resolve by FILE via the Actions API: `gh workflow list` hides
    // disabled_manually workflows from the default listing.
    const workflow = JSON.parse(gh([
      'api', `repos/${repo}/actions/workflows/portable-writer.yml`,
      '--jq', '{id, state}',
    ]).stdout)
    if (!workflow?.id) throw new Error('portable-writer.yml not found in the repository')
    workflowId = String(workflow.id)
    workflowState = String(workflow.state)
    const scheduleGate = gh(['variable', 'get', 'AIRINGCAL_WRITER_ENABLED', '--repo', repo], { allowFailure: true })
    const scheduleEnabled = scheduleGate.status === 0 && /true/i.test(String(scheduleGate.stdout))
    if (scheduleEnabled) {
      // Enabling a disabled workflow would arm the cron immediately, so the
      // schedule gate must be OFF regardless of the workflow state.
      throw new Error('Refusing first sync: the scheduled writer is enabled; disable AIRINGCAL_WRITER_ENABLED before initial acceptance')
    }
    if (workflowState === 'disabled_manually') {
      gh(['workflow', 'enable', workflowId, '--repo', repo])
      state.workflowEnabledByUs = true
      logFn('Workflow was disabled manually; enabled for the authorized dispatch (schedule gate stays closed).')
    }
    gh(['variable', 'set', gateVariable, '--env', environment, '--repo', repo, '--body', 'true'])
    state.gateOpened = true
    logFn(`Opened temporary gate ${gateVariable} for the ${environment} environment.`)
    // gh reports second-precision timestamps; use a numeric 60s window so a
    // run created in the same second as the dispatch is still matched.
    const dispatchedAtMs = now() - 60_000
    gh(['workflow', 'run', 'portable-writer.yml', '--ref', branch, '-f', `target=${environment}`, '-f', 'force_mode=full', '--repo', repo])
    let runRow = null
    for (let attempt = 0; attempt < 20 && !runRow; attempt += 1) {
      const rows = JSON.parse(gh([
        'run', 'list', '--workflow', 'portable-writer.yml', '--event', 'workflow_dispatch',
        '--limit', '10', '--json', 'databaseId,headSha,createdAt,url', '--repo', repo,
      ]).stdout)
      runRow = rows.find((row) => Date.parse(String(row.createdAt)) >= dispatchedAtMs && (!runId || String(row.databaseId) === String(runId))) ?? null
      if (!runRow) await sleep(pollMs)
    }
    if (!runRow) throw new Error('Dispatch was accepted but no matching run appeared; check the Actions tab')
    state.runId = String(runRow.databaseId)
    state.runUrl = runRow.url
    state.headSha = runRow.headSha ?? null
    logFn(`Dispatched run ${state.runId}${state.runUrl ? ` (${state.runUrl})` : ''}`)
    if (expectedSha && state.headSha && state.headSha !== expectedSha) {
      throw new Error(`Dispatched run head is ${state.headSha}, expected ${expectedSha}`)
    }
    const pattern = gateStepPattern(environment)
    const gateDeadline = now() + gateTimeoutMs
    let gateVerdict = 'pending'
    while (now() < gateDeadline) {
      const view = JSON.parse(gh(['run', 'view', state.runId, '--json', 'status,conclusion,jobs', '--repo', repo]).stdout)
      gateVerdict = gateStepVerdict(view.jobs, pattern)
      if (gateVerdict === 'passed') {
        gh(['variable', 'set', gateVariable, '--env', environment, '--repo', repo, '--body', 'false'])
        state.gateClosed = true
        logFn(`Run passed its ${environment} gate step; temporary gate closed.`)
        break
      }
      if (gateVerdict === 'failed' || view.status === 'completed') break
      await sleep(pollMs)
    }
    if (!state.gateClosed) {
      gh(['variable', 'set', gateVariable, '--env', environment, '--repo', repo, '--body', 'false'])
      state.gateClosed = true
      logFn('Closed the temporary gate without a passing gate step (run aborted early).')
    }
    const runDeadline = now() + runTimeoutMs
    let view = null
    while (now() < runDeadline) {
      view = JSON.parse(gh(['run', 'view', state.runId, '--json', 'status,conclusion', '--repo', repo]).stdout)
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
    return state
  } finally {
    // Never leave temporary authorization behind — including on timeouts,
    // dispatch failure, cancellation and unexpected throws.
    if (!state.gateClosed) {
      try {
        run('gh', ['variable', 'set', gateVariable, '--env', environment, '--repo', repo, '--body', 'false'], {
          spawnSyncImpl,
          allowFailure: true,
        })
        state.gateClosed = true
      } catch { /* best effort */ }
    }
    if (state.workflowEnabledByUs && workflowId) {
      try {
        run('gh', ['workflow', 'disable', workflowId, '--repo', repo], { spawnSyncImpl, allowFailure: true })
        state.workflowRestored = true
      } catch { /* best effort */ }
    }
  }
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
  const gate = gh(['variable', 'get', gateVariableName(environment), '--env', environment, '--repo', WIZARD_REPOSITORY])
  push(`${environment} gate`, gate.status === 0 && /true/i.test(String(gate.stdout)) ? 'warn' : 'ok',
    gate.status === 0 ? String(gate.stdout).trim() : 'unset')
  const schedule = gh(['variable', 'get', 'AIRINGCAL_WRITER_ENABLED', '--repo', WIZARD_REPOSITORY])
  push('schedule gate', schedule.status === 0 && /true/i.test(String(schedule.stdout)) ? 'warn' : 'ok',
    schedule.status === 0 ? String(schedule.stdout).trim() : 'unset')
  const runs = gh(['run', 'list', '--workflow', 'portable-writer.yml', '--limit', '3', '--json', 'databaseId,status,conclusion,headSha', '--repo', WIZARD_REPOSITORY])
  if (runs.status === 0) {
    for (const row of JSON.parse(runs.stdout)) {
      push(`recent run ${row.databaseId}`, row.status === 'completed' && row.conclusion === 'success' ? 'ok' : 'warn',
        `${row.status}/${row.conclusion ?? '-'} @ ${String(row.headSha ?? '').slice(0, 8)}`)
    }
  }
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

async function installFlow({ io, env = {}, fetchImpl, spawnSyncImpl, log: logFn, requestedEnvironment, headless }) {
  await preflight({ spawnSyncImpl })
  let environment = requestedEnvironment
  if (!environment) {
    if (headless) throw new Error('Headless mode needs --environment production|development')
    environment = await askSelect('Environment', [
      { title: 'production', hint: 'default for a normal installation', value: 'production' },
      { title: 'development', hint: 'a second, isolated deployment', value: 'development' },
    ], io)
  }
  let resolvedEnv = env
  let dotenvPath = null
  if (headless) {
    const loaded = loadHeadlessEnvironment({ environment })
    resolvedEnv = loaded.env
    dotenvPath = loaded.dotenvPath
    // #195 review: headless is env-driven by contract — never fall through
    // to an interactive secret prompt (it would block on a pty, or abort
    // with a misleading TTY message).
    const missingTokens = ['AIRINGCAL_CLOUDFLARE_API_TOKEN', 'AIRINGCAL_BANGUMI_TOKEN']
      .filter((key) => !String(resolvedEnv[key] ?? '').trim())
    if (missingTokens.length > 0) {
      throw new Error(`Headless setup needs ${missingTokens.join(', ')} in the environment/dotenv`)
    }
  }
  const { cloudflareToken, bangumiToken } = await resolveTokens({ io, env: resolvedEnv, log: logFn })
  const discovery = await discoverIdentity({
    fetchImpl,
    cloudflareToken,
    bangumiToken,
    io,
    env: resolvedEnv,
    log: logFn,
  })
  // #195 review: an env-supplied custom domain/zone is checked and bound as
  // exactly that value (no prompt whose answer would be discarded).
  const hostnameHint = String(resolvedEnv.AIRINGCAL_WORKER_CUSTOM_DOMAIN ?? '').trim()
  const zoneHint = String(resolvedEnv.AIRINGCAL_ZONE_ID ?? '').trim()
  const domain =
    headless && !hostnameHint
      ? { customDomain: '', zoneId: '' }
      : await planCustomDomain({
          fetchImpl,
          cloudflareToken,
          account: discovery.account,
          io,
          log: logFn,
          assume: hostnameHint ? true : undefined,
          hostnameHint,
          zoneHint,
          allowTakeover: String(resolvedEnv.AIRINGCAL_ALLOW_CUSTOM_DOMAIN_TAKEOVER ?? '') === 'yes',
        })
  const customDomain = String(hostnameHint || domain.customDomain || '').trim()
  const zoneId = String(zoneHint || domain.zoneId || '').trim()
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
  const dry = buildPlanForEnvironment(wizardEnv, { mode: 'dry-run' })
  logFn(`\n--- Deployment plan (${environment}) ---\n${formatPlan(dry.plan)}\n`)
  const approved = headless
    ? String(resolvedEnv.AIRINGCAL_WIZARD_CONFIRM ?? '') === 'yes'
    : await askConfirm(`Apply this plan to ${environment}?`, io)
  if (!approved) {
    logFn('Plan not applied. Re-run `pnpm setup` when ready.')
    return { applied: false }
  }
  const applyEnv = resolveApplyEnvironment({
    environment,
    headless,
    approved,
    wizardEnv,
    sourceEnv: resolvedEnv,
  })
  const { result, io: liveIo } = await applyPlan({
    env: applyEnv,
    plan: applyDerived.plan,
    log: logFn,
    spawnSyncImpl,
  })
  if (!result.ok) return { applied: false, result }
  const s3 = liveIo.s3Credentials?.() ?? null
  const wantSync = headless
    ? String(resolvedEnv.AIRINGCAL_WIZARD_FIRST_SYNC ?? '') === 'yes'
    : await askConfirm('Run the first Full Sync now (GitHub Actions, separate authorization)?', io)
  let sync = null
  if (wantSync) {
    if (!headless) {
      const confirmed = await askConfirm(
        'This dispatches the Writer for the first full synchronization (opens a temporary gate that closes automatically). Continue?',
        io,
      )
      if (!confirmed) throw new WizardAbort('First sync not authorized')
    }
    sync = await runFirstSync({
      environment,
      expectedSha: resolveGitSha(spawnSyncImpl),
      spawnSyncImpl,
      log: logFn,
    })
  }
  let verification = null
  // A release exists only after the first Full Sync; verifying an intentionally
  // unpublished install would persist spurious failures into the inventory.
  if (s3 && sync) {
    verification = runVerifier({
      base: dry.plan.workerOrigin,
      bucket: dry.plan.bucket,
      accountId: discovery.account.id,
      s3,
      spawnSyncImpl,
      log: logFn,
    })
  }
  const inventory = buildInventory({
    plan: dry.plan,
    account: discovery.account,
    identity: discovery.identity,
    environment,
    customDomain,
    buildSha: resolveGitSha(spawnSyncImpl),
    deployedAt: new Date().toISOString(),
    verification: verification ? { pass: verification.pass, failed: verification.failed ?? [] } : null,
  })
  const inventoryPath = writeInventory({
    environment,
    inventory,
    secrets: [cloudflareToken, bangumiToken, s3?.secretAccessKey ?? ''].filter(Boolean),
  })
  logFn(`\nReady.\n  Public URL: ${dry.plan.publicBaseUrl ?? dry.plan.workerOrigin}\n  Inventory:  ${inventoryPath}`)
  return { applied: true, result, sync, verification, inventory, inventoryPath }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const io = deps.io ?? { input: process.stdin, output: process.stderr }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync
  const logFn = deps.log ?? log
  const env = deps.env ?? process.env
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
        const confirmed = await askConfirm('Dispatch the first Full Sync now?', io)
        if (!confirmed) throw new WizardAbort('Sync not authorized')
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
      const result = await installFlow({ io, env, fetchImpl, spawnSyncImpl, log: logFn, requestedEnvironment: args.environment, headless: true })
      return { ok: result.applied === true, result }
    }
    const choice = await askSelect('AiringCal setup', [
      { title: 'Install or update a deployment', hint: 'two tokens, plan, apply, first sync', value: 'install' },
      { title: 'Doctor', hint: 'read-only health, gates and recent runs', value: 'doctor' },
      { title: 'Exit', value: 'exit' },
    ], io)
    if (choice === 'exit') return { ok: true, exit: true }
    if (choice === 'doctor') {
      const report = await runDoctor({ environment: 'production', spawnSyncImpl, log: logFn, env })
      return { ok: report.checks.every((check) => check.status !== 'fail'), report }
    }
    const result = await installFlow({ io, env, fetchImpl, spawnSyncImpl, log: logFn, requestedEnvironment: args.environment, headless: false })
    return { ok: result.applied === true, result }
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
