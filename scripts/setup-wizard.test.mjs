import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { applyPlan, askS3CredentialFallback, discoverIdentity, planCustomDomain, resolveApplyEnvironment, runDoctor, runFirstSync, writeInventory } from './setup-wizard.mjs'
import {
  assertInventorySanitized,
  buildInventory,
  computeVerdict,
  chooseAccount,
  formatPlan,
  gateStepVerdict,
  gateVariableName,
  wizardEnvironment,
} from './setup-wizard-lib.mjs'
import { buildDevelopmentDeployPlan, deriveProductionConfig } from './deploy-env-lib.mjs'

const ACCOUNT = 'abcdef0123456789abcdef0123456789'
const OTHER = 'fedcba9876543210fedcba9876543210'

class FakeTTY extends EventEmitter {
  isTTY = true
  written = []
  setRawMode() {}
  resume() {}
  pause() {}
  write(chunk) { this.written.push(chunk) }
  type(text) {
    return new Promise((resolve) => setImmediate(() => {
      this.emit('data', Buffer.from(text, 'utf8'))
      resolve()
    }))
  }
  get text() { return this.written.join('') }
}

function fakeIo() {
  const input = new FakeTTY()
  const output = new FakeTTY()
  return { io: { input, output }, input, output }
}

function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    const handler = routes.find(([pattern]) => pattern.test(u))
    const { status = 200, body = { success: true, result: null } } = handler ? handler[1](u, init) : {}
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { impl, calls }
}

/** Scripted gh responses for the corrected, readback-verified sync flow. */
function syncFixtures({
  sha,
  gate = 'production',
  workflowState = 'disabled_manually',
  runId = 555,
  gateConclusion = 'success',
  conclusion = 'success',
  scheduleRead = { status: 404, stdout: '', stderr: 'Not Found' },
  overrides = [],
}) {
  let dispatched = false
  let state = workflowState
  let gateValue = 'false'
  const gateName = gate === 'production' ? 'AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED' : 'AIRINGCAL_DEVELOPMENT_WRITER_ENABLED'
  const stepName = gate === 'production' ? 'Production bootstrap gate (fails closed)' : 'Development writer gate (fails closed)'
  const script = [
    ...overrides,
    [/^gh auth status/, () => ({})],
    [/^gh api repos\/Skyline-Gazer\/AiringCal\/git\/ref\/heads\/dev/, () => ({ stdout: `${sha}\n` })],
    [/^gh api repos\/Skyline-Gazer\/AiringCal\/actions\/variables\/AIRINGCAL_WRITER_ENABLED/, () => scheduleRead],
    [/^gh api repos\/Skyline-Gazer\/AiringCal\/actions\/workflows\/portable-writer\.yml/, (key) => ({
      stdout: String(key).includes('.state') ? state : JSON.stringify({ id: 407881922, state }),
    })],
    [new RegExp(`^gh api repos/Skyline-Gazer/AiringCal/environments/.*/variables/${gateName}`), () => ({ stdout: `${gateValue}\n` })],
    [/^gh workflow enable/, () => { state = 'active'; return {} }],
    [/^gh workflow disable/, () => { state = 'disabled_manually'; return {} }],
    [/^gh variable set .* --body true/, () => { gateValue = 'true'; return {} }],
    [/^gh variable set .* --body false/, () => { gateValue = 'false'; return {} }],
    [/^gh workflow run/, () => { dispatched = true; return {} }],
    [/^gh run list/, () => ({
      stdout: JSON.stringify(dispatched
        ? [{ databaseId: runId, event: 'workflow_dispatch', status: 'completed', headSha: sha, headBranch: 'dev', url: 'https://example/runs/' + runId }]
        : []),
    })],
    [/^gh run view/, () => ({
      stdout: JSON.stringify({
        databaseId: runId,
        headSha: sha,
        headBranch: 'dev',
        status: 'completed',
        conclusion,
        jobs: [{ steps: [{ name: stepName, conclusion: gateConclusion }] }],
      }),
    })],
  ]
  const spawned = scriptedSpawn(script)
  return { impl: spawned.impl, calls: spawned.calls, script }
}

function scriptedSpawn(script) {
  const calls = []
  const impl = (cmd, args, options = {}) => {
    const key = [cmd, ...args].join(' ')
    calls.push({ key, options })
    for (const [pattern, result] of script) {
      if (pattern.test(key)) {
        const value = typeof result === 'function' ? result(key, options) : result
        return { status: 0, stdout: '', stderr: '', ...value }
      }
    }
    return { status: 0, stdout: '', stderr: '', error: null }
  }
  return { impl, calls }
}

test('two-token production environment plans zoneless worker mode with canonical names (#195)', () => {
  const env = wizardEnvironment({
    environment: 'production',
    cloudflareToken: 'cf-token',
    accountId: ACCOUNT,
    workersSubdomain: 'acme',
    bangumiToken: 'bgm-token',
    identity: { userId: '857123', username: 'owner' },
    usersJson: '[{"userId":"857123","username":"owner"}]',
  })
  assert.equal(env.AIRINGCAL_PUBLIC_BASE_URL, undefined, 'no public base → worker mode')
  assert.equal(env.AIRINGCAL_ZONE_ID, undefined, 'no zone for workers.dev mode')
  const derived = deriveProductionConfig(env)
  assert.equal(derived.plan.publicOriginMode, 'worker')
  assert.equal(derived.plan.bucket, 'airingcal-production')
  assert.equal(derived.plan.cloudflareWorkerName, 'airingcal-production')
  assert.equal(derived.plan.workerOrigin, 'https://airingcal-production.acme.workers.dev')
  const text = formatPlan(derived.plan)
  assert.match(text, /airingcal-production/)
  assert.match(text, /\[mutates\]/)
})

test('custom domain environment keeps worker mode and records the zone (#195)', () => {
  const env = wizardEnvironment({
    environment: 'development',
    cloudflareToken: 'cf-token',
    accountId: ACCOUNT,
    workersSubdomain: 'acme',
    bangumiToken: 'bgm-token',
    identity: { userId: '1', username: 'a' },
    usersJson: '[{"userId":"1","username":"a"}]',
    customDomain: 'anime.example.com',
    zoneId: 'zone-1',
  })
  assert.equal(env.AIRINGCAL_PUBLIC_BASE_URL, 'https://anime.example.com')
  assert.equal(env.AIRINGCAL_WORKER_CUSTOM_DOMAIN, 'anime.example.com')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: env.AIRINGCAL_PUBLIC_BASE_URL,
    workerCustomDomain: env.AIRINGCAL_WORKER_CUSTOM_DOMAIN,
  })
  assert.equal(plan.publicOriginMode, 'worker')
  assert.equal(plan.publicHost, 'anime.example.com')
})

test('chooseAccount auto-selects exactly one and prompts for many (#195)', () => {
  const single = chooseAccount([{ id: ACCOUNT, name: 'Main' }])
  assert.equal(single.account.id, ACCOUNT)
  assert.equal(single.prompt, null)
  const many = chooseAccount([{ id: ACCOUNT, name: 'A' }, { id: OTHER, name: 'B' }])
  assert.equal(many.account, null)
  assert.equal(many.prompt.length, 2)
})

test('discoverIdentity auto-selects one account without prompting (#195)', async () => {
  const { io, input } = fakeIo()
  const fetchFake = fakeFetch([
    [/\/user\/tokens\/verify$/, () => ({ body: { success: true, result: { status: 'active' } } })],
    [/\/accounts$/, () => ({ body: { success: true, result: [{ id: ACCOUNT, name: 'Main' }] } })],
    [/workers\/subdomain$/, () => ({ body: { success: true, result: { subdomain: 'acme' } } })],
    [/api\.bgm\.tv\/v0\/me$/, () => ({ body: { id: 857123, username: 'owner' } })],
  ])
  const result = await discoverIdentity({
    fetchImpl: fetchFake.impl,
    cloudflareToken: 'cf-token',
    bangumiToken: 'bgm-token',
    io,
    log: () => {},
  })
  assert.equal(result.account.id, ACCOUNT)
  assert.equal(result.workersSubdomain, 'acme')
  assert.deepEqual(result.identity, { userId: '857123', username: 'owner' })
  assert.deepEqual(JSON.parse(result.usersJson), [{ userId: '857123', username: 'owner' }])
  assert.equal(input.written.length, 0, 'no prompt for a single account')
})

test('discoverIdentity prompts when the token sees multiple accounts (#195)', async () => {
  const { io, input } = fakeIo()
  const fetchFake = fakeFetch([
    [/\/user\/tokens\/verify$/, () => ({ body: { success: true, result: { status: 'active' } } })],
    [/\/accounts$/, () => ({ body: { success: true, result: [{ id: ACCOUNT, name: 'A' }, { id: OTHER, name: 'B' }] } })],
    [/workers\/subdomain$/, () => ({ body: { success: true, result: { subdomain: 'acme' } } })],
    [/api\.bgm\.tv\/v0\/me$/, () => ({ body: { id: 1, username: 'u' } })],
  ])
  const pending = discoverIdentity({
    fetchImpl: fetchFake.impl,
    cloudflareToken: 'cf',
    bangumiToken: 'bgm',
    io,
    log: () => {},
  })
  // Let the account listing resolve, then answer the select prompt.
  await new Promise((r) => setTimeout(r, 20))
  await input.type('2\r')
  const result = await pending
  assert.equal(result.account.id, OTHER)
})

test('explicit account id must be visible to the token (never guessed) (#195)', async () => {
  const { io } = fakeIo()
  const fetchFake = fakeFetch([
    [/\/user\/tokens\/verify$/, () => ({ body: { success: true, result: { status: 'active' } } })],
    [/\/accounts$/, () => ({ body: { success: true, result: [{ id: ACCOUNT, name: 'A' }] } })],
  ])
  await assert.rejects(
    () => discoverIdentity({
      fetchImpl: fetchFake.impl,
      cloudflareToken: 'cf',
      bangumiToken: 'bgm',
      io,
      env: { AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: OTHER },
      log: () => {},
    }),
    /not visible to this token/,
  )
})

test('planCustomDomain defaults to no domain and refuses silent takeover (#195)', async () => {
  const { io, input } = fakeIo()
  const declined = planCustomDomain({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: [] }) }),
    cloudflareToken: 'cf',
    account: { id: ACCOUNT, name: 'A' },
    io,
    log: () => {},
    assume: false,
  })
  assert.deepEqual(await declined, { customDomain: '', zoneId: '' })

  const { io: io2, input: input2 } = fakeIo()
  const fetchFake = fakeFetch([
    [/\/zones\?/, () => ({ body: { success: true, result: [{ id: 'zone-1', name: 'example.com', status: 'active' }] } })],
    [/dns_records\?name=anime\.example\.com/, () => ({
      body: { success: true, result: [{ id: 'r1', name: 'anime.example.com', type: 'CNAME', content: 'old.example.net' }] },
    })],
  ])
  const pending = planCustomDomain({ fetchImpl: fetchFake.impl, cloudflareToken: 'cf', account: { id: ACCOUNT, name: 'A' }, io: io2, log: () => {}, assume: true })
  await new Promise((r) => setTimeout(r, 20))
  await input2.type('anime.example.com\r')
  await new Promise((r) => setTimeout(r, 20))
  await input2.type('n\r')
  await assert.rejects(pending, /Refusing to take over/)
})

test('applyPlan refuses production mutations without both existing gates (#195)', async () => {
  const plan = deriveProductionConfig(wizardEnvironment({
    environment: 'production',
    cloudflareToken: 'cf',
    accountId: ACCOUNT,
    bangumiToken: 'bgm',
    identity: { userId: '1', username: 'a' },
    usersJson: '[{"userId":"1","username":"a"}]',
  }), { mode: 'apply' }).plan
  await assert.rejects(
    () => applyPlan({ env: { AIRINGCAL_ENV: 'production' }, plan, log: () => {} }),
    /gates are not set/,
  )
})

test('runFirstSync opens only the env gate, closes it after the gate step and restores the workflow (#195)', async () => {
  const sha = 'a'.repeat(40)
  const { impl, calls } = syncFixtures({ sha, gate: 'production' })
  const result = await runFirstSync({
    environment: 'production',
    expectedSha: sha,
    spawnSyncImpl: impl,
    log: () => {},
    sleep: async () => {},
    now: () => Date.now(),
  })
  assert.equal(result.runId, '555')
  assert.equal(result.gateOpened, true)
  assert.equal(result.gateClosed, true)
  assert.equal(result.workflowEnabledByUs, true)
  assert.equal(result.workflowRestored, true)
  const keys = calls.map((c) => c.key)
  assert.ok(keys.some((k) => k.includes('--body true')), 'gate opened')
  assert.ok(keys.some((k) => k.includes('--body false')), 'gate closed')
  assert.equal(keys.filter((k) => k.includes('AIRINGCAL_WRITER_ENABLED --repo') && k.startsWith('gh variable set')).length, 0,
    'schedule gate is never touched')
})

test('runFirstSync closes the temporary gate even when the gate step fails (#195)', async () => {
  const sha = 'b'.repeat(40)
  const { impl, calls } = syncFixtures({
    sha,
    gate: 'development',
    workflowState: 'active',
    runId: 777,
    gateConclusion: 'failure',
    conclusion: 'failure',
  })
  await assert.rejects(
    () => runFirstSync({ environment: 'development', expectedSha: sha, spawnSyncImpl: impl, log: () => {}, sleep: async () => {} }),
    /gate step/,
  )
  assert.ok(calls.some((c) => c.key.includes('AIRINGCAL_DEVELOPMENT_WRITER_ENABLED') && c.key.includes('--body false')),
    'gate closed in cleanup')
})

test('runFirstSync refuses a remote head that does not match the expected SHA (#195)', async () => {
  const { impl } = syncFixtures({ sha: 'c'.repeat(40), gate: 'production' })
  await assert.rejects(
    () => runFirstSync({ environment: 'production', expectedSha: 'd'.repeat(40), spawnSyncImpl: impl, log: () => {}, sleep: async () => {} }),
    /expected/,
  )
})

test('gateStepVerdict distinguishes passed/failed/pending (#195)', () => {
  const pattern = /bootstrap gate/i
  assert.equal(gateStepVerdict([{ steps: [{ name: 'Production bootstrap gate (fails closed)', conclusion: 'success' }] }], pattern), 'passed')
  assert.equal(gateStepVerdict([{ steps: [{ name: 'Production bootstrap gate (fails closed)', conclusion: 'failure' }] }], pattern), 'failed')
  assert.equal(gateStepVerdict([{ steps: [{ name: 'Production bootstrap gate (fails closed)', conclusion: null }] }], pattern), 'pending')
  assert.equal(gateStepVerdict([], pattern), 'pending')
})

test('inventory is sanitized and refuses secret leakage (#195)', () => {
  const plan = buildDevelopmentDeployPlan({ target: 'cloudflare', publicBaseUrl: '' })
  const inventory = buildInventory({
    plan,
    account: { id: ACCOUNT, name: 'Main' },
    identity: { userId: '1', username: 'a' },
    environment: 'development',
    buildSha: 'e'.repeat(40),
    deployedAt: '2026-11-26T00:00:00.000Z',
  })
  assert.equal(inventory.environment, 'development')
  assert.equal(inventory.worker.name, 'airingcal-development')
  assert.equal(inventory.cloudflare.workersDevSubdomain, 'r7a', 'subdomain without the workers.dev suffix')
  assert.equal(inventory.github.gateVariable, gateVariableName('development'))
  assertInventorySanitized(inventory, ['cf-secret', 'bgm-secret'])
  assert.throws(() => assertInventorySanitized(inventory, ['airingcal-development']), /leaked/)
  assert.equal(JSON.stringify(inventory).includes('cf-secret'), false)
})

test('writeInventory writes 0600 under .airingcal and never a secret (#195)', async () => {
  const { mkdtempSync, statSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'wizard-inv-'))
  const plan = buildDevelopmentDeployPlan({ target: 'cloudflare', publicBaseUrl: '' })
  const inventory = buildInventory({
    plan,
    account: { id: ACCOUNT, name: 'Main' },
    identity: { userId: '1', username: 'a' },
    environment: 'development',
  })
  const path = writeInventory({ environment: 'development', inventory, baseDir: base })
  assert.equal(path.endsWith(join('.airingcal', 'inventory.development.json')), true)
  const mode = statSync(path).mode & 0o777
  assert.equal(mode, 0o600)
  assert.equal(readFileSync(path, 'utf8').includes('airingcal-development'), true)
})

test('runFirstSync refuses when the schedule gate is enabled, before arming anything (#195)', async () => {
  const sha = 'f'.repeat(40)
  const { impl, calls } = syncFixtures({
    sha,
    gate: 'production',
    scheduleRead: { status: 0, stdout: 'true\n' },
  })
  await assert.rejects(
    () => runFirstSync({ environment: 'production', expectedSha: sha, spawnSyncImpl: impl, log: () => {}, sleep: async () => {} }),
    /scheduled writer is enabled/,
  )
  const keys = calls.map((c) => c.key)
  assert.equal(keys.some((k) => k.startsWith('gh workflow enable')), false, 'workflow never enabled')
  assert.equal(keys.some((k) => k.includes('--body true')), false, 'gate never opened')
})

test('writeInventory enforces the value-level secret check with the run secrets (#195)', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'wizard-inv-secret-'))
  const plan = buildDevelopmentDeployPlan({ target: 'cloudflare', publicBaseUrl: '' })
  const inventory = buildInventory({
    plan,
    account: { id: ACCOUNT, name: 'Main' },
    identity: { userId: '1', username: 'a' },
    environment: 'development',
  })
  assert.throws(
    () => writeInventory({ environment: 'development', inventory, baseDir: base, secrets: ['airingcal-development'] }),
    /leaked/,
  )
})

// ---------------------------------------------------------------------------
// #195 reviewer findings: apply-env gates, engine inputs, domain hints
// ---------------------------------------------------------------------------

const WIZARD_ENV_BASE = Object.freeze({ AIRINGCAL_ENV: 'production', AIRINGCAL_CLOUDFLARE_API_TOKEN: 'cf' })

test('headless production never synthesizes the apply gates from the wizard confirmation (#195 review)', () => {
  assert.throws(
    () => resolveApplyEnvironment({
      environment: 'production',
      headless: true,
      approved: true,
      wizardEnv: WIZARD_ENV_BASE,
      sourceEnv: { AIRINGCAL_WIZARD_CONFIRM: 'yes' },
    }),
    /AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes and AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes/,
  )
  const headless = resolveApplyEnvironment({
    environment: 'production',
    headless: true,
    approved: true,
    wizardEnv: WIZARD_ENV_BASE,
    sourceEnv: {
      AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED: 'yes',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
  })
  assert.equal(headless.AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED, 'yes')
  assert.equal(headless.AIRINGCAL_DEPLOY_LIVE_CONFIRM, 'yes')
  const interactive = resolveApplyEnvironment({
    environment: 'production',
    headless: false,
    approved: true,
    wizardEnv: WIZARD_ENV_BASE,
    sourceEnv: {},
  })
  assert.equal(interactive.AIRINGCAL_DEPLOY_LIVE_CONFIRM, 'yes', 'interactive confirmation is the only synthesis')
  assert.throws(
    () => resolveApplyEnvironment({ environment: 'development', headless: false, approved: false, wizardEnv: {} }),
    /not authorized/,
  )
})

test('apply env forwards engine inputs (S3 overrides, writer rotation id) (#195 review)', () => {
  const env = resolveApplyEnvironment({
    environment: 'development',
    headless: true,
    approved: true,
    wizardEnv: { AIRINGCAL_ENV: 'development' },
    sourceEnv: {
      AIRINGCAL_S3_ACCESS_KEY_ID: 'ak',
      AIRINGCAL_S3_SECRET_ACCESS_KEY: 'sk',
      AIRINGCAL_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      AIRINGCAL_S3_REGION: 'auto',
      AIRINGCAL_WRITER_TOKEN_ROTATION_ID: 'tok-9',
      AIRINGCAL_WIZARD_CONFIRM: 'yes',
    },
  })
  assert.equal(env.AIRINGCAL_S3_ACCESS_KEY_ID, 'ak')
  assert.equal(env.AIRINGCAL_WRITER_TOKEN_ROTATION_ID, 'tok-9')
  assert.equal(env.AIRINGCAL_WIZARD_CONFIRM, undefined, 'wizard-only flags are not forwarded')
})

test('env-supplied custom domain is the hostname that gets DNS-checked, without prompts (#195 review)', async () => {
  const { io, input } = fakeIo()
  const fetchFake = fakeFetch([
    [/\/zones\?/, () => ({ body: { success: true, result: [{ id: 'zone-1', name: 'example.com', status: 'active' }] } })],
    [/dns_records\?name=anime\.example\.com/, () => ({ body: { success: true, result: [] } })],
  ])
  const result = await planCustomDomain({
    fetchImpl: fetchFake.impl,
    cloudflareToken: 'cf',
    account: { id: ACCOUNT, name: 'A' },
    io,
    log: () => {},
    assume: true,
    hostnameHint: 'anime.example.com',
    zoneHint: 'zone-1',
  })
  assert.equal(result.customDomain, 'anime.example.com')
  assert.equal(result.zoneId, 'zone-1')
  assert.equal(input.written.length, 0, 'no prompts when both hints are supplied')
  assert.ok(fetchFake.calls.some((c) => c.url.includes('name=anime.example.com')), 'DNS checked for the exact name')
})

test('non-interactive takeover of an env-supplied domain is refused without the explicit flag (#195 review)', async () => {
  const fetchFake = fakeFetch([
    [/\/zones\?/, () => ({ body: { success: true, result: [{ id: 'zone-1', name: 'example.com', status: 'active' }] } })],
    [/dns_records\?name=anime\.example\.com/, () => ({ body: { success: true, result: [{ id: 'r1', name: 'anime.example.com', type: 'CNAME', content: 'old.example.net' }] } })],
  ])
  await assert.rejects(
    () => planCustomDomain({
      fetchImpl: fetchFake.impl,
      cloudflareToken: 'cf',
      account: { id: ACCOUNT, name: 'A' },
      io: { input: { isTTY: false }, output: { write() {} } },
      log: () => {},
      assume: true,
      hostnameHint: 'anime.example.com',
      zoneHint: 'zone-1',
    }),
    /non-interactively/,
  )
  const authorised = await planCustomDomain({
    fetchImpl: fetchFake.impl,
    cloudflareToken: 'cf',
    account: { id: ACCOUNT, name: 'A' },
    io: { input: { isTTY: false }, output: { write() {} } },
    log: () => {},
    assume: true,
    hostnameHint: 'anime.example.com',
    zoneHint: 'zone-1',
    allowTakeover: true,
  })
  assert.equal(authorised.customDomain, 'anime.example.com')
})

test('inventory sanitizer rejects token-shaped fields outside writerToken (#195 review)', () => {
  const plan = buildDevelopmentDeployPlan({ target: 'cloudflare', publicBaseUrl: '' })
  const base = buildInventory({
    plan,
    account: { id: ACCOUNT, name: 'Main' },
    identity: { userId: '1', username: 'a' },
    environment: 'development',
  })
  assert.doesNotThrow(() => assertInventorySanitized(base))
  assert.throws(
    () => assertInventorySanitized({ ...base, extra: { token: 'x'.repeat(32) } }),
    /token-shaped/,
  )
})

// ---------------------------------------------------------------------------
// #195 acceptance correction: actual credential facts + masked fallback
// ---------------------------------------------------------------------------

test('inventory records the actual Writer credential source/scope, never a desired token name (#195 correction)', () => {
  const plan = buildDevelopmentDeployPlan({ target: 'cloudflare', publicBaseUrl: '' })
  const inventory = buildInventory({
    plan,
    account: { id: ACCOUNT, name: 'Main' },
    identity: { userId: '1', username: 'a' },
    environment: 'production',
    writerCredential: {
      source: 'management-token',
      scope: 'account-wide-derived',
      accessKeyId: 'tok-id',
      secretAccessKey: 'must-not-appear',
    },
  })
  assert.equal(inventory.writerCredential.source, 'management-token')
  assert.equal(inventory.writerCredential.scope, 'account-wide-derived')
  assert.equal(JSON.stringify(inventory).includes('airingcal-production-writer'), false,
    'no canonical token name when no such token was created')
  assert.equal(JSON.stringify(inventory).includes('must-not-appear'), false, 'secret never persisted')
  assert.doesNotThrow(() => assertInventorySanitized(inventory, ['must-not-appear']))
})

test('interactive S3 credential fallback is genuinely masked and skips other prompts (#195 correction)', async () => {
  const { io, input, output } = fakeIo()
  const pending = askS3CredentialFallback(io)
  await new Promise((r) => setTimeout(r, 10))
  await input.type('AKIA_REAL_KEY_VALUE\r')
  await new Promise((r) => setTimeout(r, 10))
  await input.type('real-secret-value\r')
  const creds = await pending
  assert.equal(creds.AIRINGCAL_S3_ACCESS_KEY_ID, 'AKIA_REAL_KEY_VALUE')
  assert.equal(creds.AIRINGCAL_S3_SECRET_ACCESS_KEY, 'real-secret-value')
  assert.equal(output.text.includes('AKIA_REAL_KEY_VALUE'), false, 'access key not echoed')
  assert.equal(output.text.includes('real-secret-value'), false, 'secret not echoed')
  assert.equal((output.text.match(/\*/g) ?? []).length >= 20, true, 'masked characters echoed')
})

// ---------------------------------------------------------------------------
// #195 correction: cleanup failure paths must never produce success receipts
// ---------------------------------------------------------------------------

test('unsuccessful temporary-gate closure is reported with HIGH PRIORITY recovery (#195 correction)', async () => {
  const sha = 'a'.repeat(40)
  const { impl } = syncFixtures({
    sha,
    gate: 'production',
    overrides: [[/^gh variable set .* --body false/, () => ({ status: 1, stdout: '', stderr: 'permission denied' })]],
  })
  let error
  try {
    await runFirstSync({ environment: 'production', expectedSha: sha, spawnSyncImpl: impl, log: () => {}, sleep: async () => {} })
  } catch (caught) { error = caught }
  assert.ok(error, 'failed gate closure must throw')
  assert.match(error.message, /HIGH PRIORITY/)
  assert.match(error.message, /UNVERIFIED/)
  assert.equal(error.state.gateClosed, false, 'no false closure receipt')
  assert.equal(error.state.cleanupVerified, false)
})

test('unsuccessful workflow restoration is reported with HIGH PRIORITY recovery (#195 correction)', async () => {
  const sha = 'b'.repeat(40)
  const { impl } = syncFixtures({
    sha,
    gate: 'production',
    overrides: [[/^gh workflow disable/, () => ({ status: 1, stdout: '', stderr: 'permission denied' })]],
  })
  let error
  try {
    await runFirstSync({ environment: 'production', expectedSha: sha, spawnSyncImpl: impl, log: () => {}, sleep: async () => {} })
  } catch (caught) { error = caught }
  assert.ok(error, 'failed workflow restoration must throw')
  assert.match(error.message, /HIGH PRIORITY/)
  assert.match(error.message, /disable workflow|workflow restoration/)
  assert.equal(error.state.workflowRestored, false)
  assert.equal(error.state.cleanupVerified, false)
})

test('unreadable gate state is never treated as safely closed (#195 correction)', async () => {
  const sha = 'c'.repeat(40)
  const { impl } = syncFixtures({
    sha,
    gate: 'development',
    overrides: [[
      new RegExp('^gh api repos/Skyline-Gazer/AiringCal/environments/.*/variables/.*WRITER_ENABLED'),
      () => ({ status: 500, stdout: '', stderr: 'API unavailable' }),
    ]],
  })
  const error = await runFirstSync({
    environment: 'development', expectedSha: sha, spawnSyncImpl: impl, log: () => {}, sleep: async () => {},
  }).then(() => null, (caught) => caught)
  assert.ok(error, 'unreadable gate must abort')
  assert.match(error.message, /UNVERIFIED|HIGH PRIORITY/)
  const doctor = await runDoctor({
    environment: 'development',
    spawnSyncImpl: scriptedSpawn([
      [/^gh auth status/, () => ({})],
      [/^gh api repos\/Skyline-Gazer\/AiringCal\/actions\/variables\/AIRINGCAL_WRITER_ENABLED/, () => ({ status: 500, stderr: 'API unavailable' })],
      [/^gh api repos\/Skyline-Gazer\/AiringCal\/actions\/workflows\/portable-writer\.yml/, () => ({ stdout: JSON.stringify({ id: 7, state: 'disabled_manually' }) })],
      [/^gh api repos\/Skyline-Gazer\/AiringCal\/environments\/development\/variables\/AIRINGCAL_DEVELOPMENT_WRITER_ENABLED/, () => ({ status: 500, stderr: 'API unavailable' })],
      [/^gh run list/, () => ({ stdout: '[]' })],
    ]).impl,
    log: () => {},
  })
  assert.equal(doctor.checks.find((check) => /schedule gate/.test(check.name)).status, 'fail',
    'doctor must fail on an unreadable schedule gate')
  assert.equal(doctor.checks.find((check) => /development gate/.test(check.name)).status, 'fail',
    'doctor must fail on an unreadable environment gate')
})

test('ambiguous new runs are refused instead of selecting an unrelated recent run (#195 correction)', async () => {
  const sha = 'd'.repeat(40)
  let listCalls = 0
  const { impl } = syncFixtures({
    sha,
    gate: 'production',
    overrides: [[/^gh run list/, () => {
      listCalls += 1
      if (listCalls === 1) return { stdout: '[]' }
      return {
        stdout: JSON.stringify([
          { databaseId: 900, event: 'workflow_dispatch', status: 'in_progress', headSha: sha, headBranch: 'dev', url: 'a' },
          { databaseId: 901, event: 'workflow_dispatch', status: 'in_progress', headSha: sha, headBranch: 'dev', url: 'b' },
        ]),
      }
    }]],
  })
  const error = await runFirstSync({
    environment: 'production', expectedSha: sha, spawnSyncImpl: impl, log: () => {}, sleep: async () => {},
  }).then(() => null, (caught) => caught)
  assert.ok(error)
  assert.match(error.message, /Ambiguous dispatch/)
  assert.equal(error.state.runId, null, 'no run selected from ambiguity')
})

test('active Writer run blocks dispatch before any gate is opened (#195 correction)', async () => {
  const sha = 'e'.repeat(40)
  const { impl, calls } = syncFixtures({
    sha,
    gate: 'production',
    overrides: [[/^gh run list/, () => ({
      stdout: JSON.stringify([{ databaseId: 800, event: 'workflow_dispatch', status: 'in_progress', headSha: sha, headBranch: 'dev' }]),
    })]],
  })
  await assert.rejects(
    () => runFirstSync({ environment: 'production', expectedSha: sha, spawnSyncImpl: impl, log: () => {}, sleep: async () => {} }),
    /single-flight/,
  )
  assert.equal(calls.some((call) => call.key.includes('--body true')), false, 'gate never opened')
})

test('non-interactive first sync needs its own explicit authorization (#195 correction)', async () => {
  const { main } = await import('./setup-wizard.mjs')
  const result = await main(['--sync', '--headless', '--environment', 'development'], {
    env: {},
    io: { input: { isTTY: false }, output: { write() {} } },
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    log: () => {},
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /AIRINGCAL_WIZARD_SYNC_AUTHORIZED=yes/)
})

// ---------------------------------------------------------------------------
// #195 correction: explicit terminal verdicts, no premature READY
// ---------------------------------------------------------------------------

test('terminal verdicts distinguish deployment from initialization (#195 correction)', () => {
  const passing = { pass: true, checks: [], failed: [] }
  assert.deepEqual(computeVerdict({ applied: false, wantSync: false, applyReason: 'apply aborted' }), {
    verdict: 'DEPLOY_FAILED', reason: 'apply aborted',
  })
  assert.equal(computeVerdict({ applied: true, wantSync: false, headless: false }).verdict, 'AWAITING_FIRST_SYNC')
  assert.equal(computeVerdict({ applied: true, wantSync: false, headless: true }).verdict, 'DEPLOYED')
  assert.equal(computeVerdict({
    applied: true, wantSync: true, sync: { runId: '1' }, syncError: new Error('gate cleanup failed'), verification: passing,
  }).verdict, 'SYNC_FAILED')
  assert.equal(computeVerdict({
    applied: true, wantSync: true, sync: { runId: '1' }, verification: { pass: false, failed: ['private-object-exists'] },
  }).verdict, 'VERIFICATION_FAILED')
  assert.equal(computeVerdict({
    applied: true, wantSync: true, sync: { runId: '1' }, verification: passing,
  }).verdict, 'READY')
  assert.equal(computeVerdict({ applied: true, wantSync: true, sync: { runId: '1' } }).verdict, 'VERIFICATION_FAILED',
    'unverified is never READY')
})

test('inventory preserves mutation receipts on a partial apply failure (#195 correction)', () => {
  const plan = buildDevelopmentDeployPlan({ target: 'cloudflare', publicBaseUrl: '' })
  const inventory = buildInventory({
    plan,
    account: { id: ACCOUNT, name: 'Main' },
    identity: { userId: '1', username: 'a' },
    environment: 'development',
    verdict: 'DEPLOY_FAILED',
    mutationReceipts: [{
      status: 'aborted',
      completed: ['token-probe', 'ensure-bucket'],
      mutationsExecuted: ['ensure-bucket'],
      reason: 'writer credential unavailable',
    }],
  })
  assert.equal(inventory.deployment.verdict, 'DEPLOY_FAILED')
  assert.deepEqual(inventory.mutationReceipts[0].completed, ['token-probe', 'ensure-bucket'])
  assert.deepEqual(inventory.mutationReceipts[0].mutationsExecuted, ['ensure-bucket'])
  assert.doesNotThrow(() => assertInventorySanitized(inventory))
})

// ---------------------------------------------------------------------------
// #208 BUG-002 / UX-011 / UX-012: interactive session lifecycle & reuse
// ---------------------------------------------------------------------------

function makeScriptedUi(steps) {
  const notes = []
  const passwordPrompts = []
  const confirmPrompts = []
  const next = (type, message) => {
    const idx = steps.findIndex((s) => s.type === type && (!s.match || s.match.test(message)))
    if (idx === -1) throw new Error(`Unexpected prompt (${type}): ${message}`)
    const [step] = steps.splice(idx, 1)
    return step.value
  }
  return {
    notes,
    passwordPrompts,
    confirmPrompts,
    interactive: true,
    color: false,
    theme: 'auto',
    prompts: {
      select: async ({ message }) => next('select', message),
      confirm: async (arg) => {
        const msg = typeof arg === 'string' ? arg : arg.message
        confirmPrompts.push(msg)
        return next('confirm', msg)
      },
      text: async ({ message }) => next('text', message),
      password: async ({ message }) => {
        passwordPrompts.push(msgOr(message))
        return next('password', message)
      },
    },
    select: async (arg) => next('select', typeof arg === 'string' ? arg : arg.message),
    confirm: async (arg) => {
      const msg = typeof arg === 'string' ? arg : arg.message
      confirmPrompts.push(msg)
      return next('confirm', msg)
    },
    text: async (arg) => next('text', typeof arg === 'string' ? arg : arg.message),
    password: async (arg) => {
      const msg = typeof arg === 'string' ? arg : arg.message
      passwordPrompts.push(msg)
      return next('password', msg)
    },
    log: { info() {}, step() {}, success() {}, warn() {}, error() {} },
    spinner: () => ({ start() {}, stop() {}, fail() {} }),
    intro() {},
    outro() {},
    cancel() {},
    note(msg, title) { notes.push({ title, msg }) },
    link(l, u) { return `${l}: ${u}` },
  }
}

function msgOr(x) { return String(x ?? '') }

test('BUG-002 & UX-011: Validate -> Details -> Main Menu -> Doctor -> Main Menu -> Install reuses in-memory credentials and requires fresh authorization (#208)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { main: wizardMain } = await import('./setup-wizard.mjs')
  const invDir = mkdtempSync(join(tmpdir(), 'wizard-lifecycle-'))
  try {
    const fetchFake = fakeFetch([
      [/\/user\/tokens\/verify$/, () => ({ body: { success: true, result: { id: 't1', status: 'active' } } })],
      [/\/accounts$/, () => ({ body: { success: true, result: [{ id: ACCOUNT, name: 'Main' }] } })],
      [/workers\/subdomain$/, () => ({ body: { success: true, result: { subdomain: 'acme' } } })],
      [/\/workers\/scripts$/, () => ({ body: { success: true, result: [] } })],
      [/\/r2\/buckets$/, () => ({ body: { success: true, result: { buckets: [] } } })],
      [/\/user\/tokens\/permissions$/, () => ({ body: { success: true, result: { permissions: ['User API Tokens:Edit'] } } })],
      [/api\.bgm\.tv\/v0\/me$/, () => ({ body: { id: 857123, username: 'owner' } })],
      [/users\/owner\/collections/, () => ({ body: { total: 1, data: [{ subject_id: 9 }] } })],
      [/\-\/collections\/9\/episodes/, () => ({ body: { total: 1, data: [] } })],
    ])
    const spawnStub = (cmd, args) => {
      if (cmd === 'git') return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (cmd === 'gh' && args[0] === 'api' && String(args[1]).includes('portable-writer.yml')) {
        return { status: 0, stdout: JSON.stringify({ id: 7, state: 'disabled_manually' }), stderr: '' }
      }
      if (cmd === 'gh' && args[0] === 'api' && String(args[1]).includes('/environments/')) {
        return { status: 404, stdout: '', stderr: 'Not Found' }
      }
      if (cmd === 'gh' && args[0] === 'run') return { status: 0, stdout: '[]', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    }
    const ui = makeScriptedUi([
      { type: 'select', match: /AiringCal Setup/, value: 'validate' },
      { type: 'password', match: /Cloudflare API Token/, value: 'cf-mem-token' },
      { type: 'password', match: /Bangumi Personal Access Token/, value: 'bgm-mem-token' },
      { type: 'select', match: /Next Action/, value: 'details' },
      { type: 'select', match: /Next Action/, value: 'menu' },
      { type: 'select', match: /AiringCal Setup/, value: 'doctor' },
      { type: 'select', match: /Doctor Next Action/, value: 'menu' },
      { type: 'select', match: /AiringCal Setup/, value: 'install' },
      { type: 'select', match: /Environment/, value: 'production' },
      { type: 'confirm', match: /Custom Domain/, value: false },
      { type: 'select', match: /Review Configuration/, value: 'install' },
      { type: 'confirm', match: /Install AiringCal in Production now/, value: true },
      { type: 'confirm', match: /Run the First Full Sync now/, value: false },
    ])
    const appliedCalls = []
    const res = await wizardMain([], {
      env: { ...process.env, AIRINGCAL_INVENTORY_DIR: invDir },
      fetchImpl: fetchFake.impl,
      spawnSyncImpl: spawnStub,
      ui,
      log: () => {},
      hooks: {
        preflight: async () => {},
        createApplyIo: () => ({
          s3Credentials: () => ({ source: 'scoped-token', scope: 'bucket-scoped', accessKeyId: 'k1', tokenName: 'airingcal-production-writer', tokenId: 'k1' }),
          probeToken: async () => ({ ok: true }),
          deriveAndVerifyS3: async (ctx) => { ctx.writerCredentialDeferred = true; return { deferred: true } },
          ensureBucket: async () => { appliedCalls.push('ensureBucket'); return { bucket: 'airingcal-production', created: true } },
          provisionProductionWriter: async () => { appliedCalls.push('provision'); return { verified: true } },
          verifyBucketEmpty: async () => ({ emptyVerified: true }),
          disableR2Dev: async () => ({ disabled: true }),
          syncGithubEnvironment: async () => ({ environment: 'production' }),
          deployCloudflareReader: async () => ({ deployed: true, workerUrl: 'https://airingcal-production.acme.workers.dev' }),
          verifyImageRouting: async () => ({ status: 'skipped-no-release' }),
          validateImageCdn: async () => ({ enabled: false }),
          writeIsolationProbe: async () => ({ key: 'checkpoints/_isolation-probe.txt', body: 'isolation-probe', exists: true }),
          probeAnonymousAccess: async () => ({
            r2DevDisabled: true,
            probes: [
              { url: 'https://airingcal-production.acme.workers.dev/checkpoints/_isolation-probe.txt', method: 'GET', status: 404 },
              { url: 'https://airingcal-production.acme.workers.dev/checkpoints/_isolation-probe.txt', method: 'HEAD', status: 404 },
            ],
          }),
          deleteIsolationProbe: async () => ({ key: 'checkpoints/_isolation-probe.txt', deleted: true }),
        }),
      },
    })
    assert.equal(res.ok, true)
    assert.equal(res.verdict, 'AWAITING_FIRST_SYNC')
    assert.equal(ui.passwordPrompts.length, 2, 'tokens entered once during validation and reused in memory')
    assert.ok(ui.notes.some((n) => n.title === 'Validation Summary'))
    assert.ok(ui.notes.some((n) => n.title === 'Detailed Validation Results'))
    assert.ok(ui.confirmPrompts.some((p) => /Install AiringCal in Production now/.test(p)), 'fresh apply authorization required')
    assert.deepEqual(appliedCalls, ['ensureBucket', 'provision'])
  } finally {
    rmSync(invDir, { recursive: true, force: true })
  }
})

test('UX-012: interactive failure recovery menu allows Reconcile, Details, and Exit Safely without blind retry (#208)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { main: wizardMain } = await import('./setup-wizard.mjs')
  const invDir = mkdtempSync(join(tmpdir(), 'wizard-recovery-menu-'))
  try {
    const fetchFake = fakeFetch([
      [/\/user\/tokens\/verify$/, () => ({ body: { success: true, result: { id: 't1', status: 'active' } } })],
      [/\/accounts$/, () => ({ body: { success: true, result: [{ id: ACCOUNT, name: 'Main' }] } })],
      [/workers\/subdomain$/, () => ({ body: { success: true, result: { subdomain: 'acme' } } })],
      [/\/workers\/scripts$/, () => ({ body: { success: true, result: [] } })],
      [/\/r2\/buckets$/, () => ({ body: { success: true, result: { buckets: [] } } })],
      [/\/user\/tokens\/permissions$/, () => ({ body: { success: true, result: { permissions: ['User API Tokens:Edit'] } } })],
      [/\/user\/tokens$/, () => ({ status: 403, body: { success: false } })],
      [/api\.bgm\.tv\/v0\/me$/, () => ({ body: { id: 857123, username: 'owner' } })],
      [/users\/owner\/collections/, () => ({ body: { total: 1, data: [{ subject_id: 9 }] } })],
      [/\-\/collections\/9\/episodes/, () => ({ body: { total: 1, data: [] } })],
    ])
    const ui = makeScriptedUi([
      { type: 'select', match: /AiringCal Setup/, value: 'install' },
      { type: 'select', match: /Environment/, value: 'production' },
      { type: 'password', match: /Cloudflare API Token/, value: 'cf-mem-token' },
      { type: 'password', match: /Bangumi Personal Access Token/, value: 'bgm-mem-token' },
      { type: 'confirm', match: /Custom Domain/, value: false },
      { type: 'select', match: /Review Configuration/, value: 'install' },
      { type: 'confirm', match: /Install AiringCal in Production now/, value: true },
      { type: 'select', match: /Recovery Action/, value: 'details' },
      { type: 'select', match: /Recovery Action/, value: 'reconcile' },
      { type: 'select', match: /Recovery Action/, value: 'exit' },
    ])
    const res = await wizardMain([], {
      env: { ...process.env, AIRINGCAL_INVENTORY_DIR: invDir },
      fetchImpl: fetchFake.impl,
      spawnSyncImpl: () => ({ status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }),
      ui,
      log: () => {},
      hooks: {
        preflight: async () => {},
        createApplyIo: () => ({
          s3Credentials: () => null,
          probeToken: async () => ({ ok: true }),
          deriveAndVerifyS3: async (ctx) => { ctx.writerCredentialDeferred = true; return { deferred: true } },
          ensureBucket: async (ctx) => {
            ctx.ledger.begin({ op: 'r2-bucket-create', stepId: 'ensure-bucket', resourceType: 'r2-bucket', target: 'airingcal-production' }).confirm('created')
            return { bucket: 'airingcal-production', created: true }
          },
          provisionProductionWriter: async () => {
            const err = new Error('provider incompatible group')
            err.errorCategory = 'provider-incompatibility'
            err.code = 'PERMISSION_GROUP_MISSING'
            throw err
          },
          verifyBucketEmpty: async () => ({ emptyVerified: true }),
        }),
      },
    })
    assert.equal(res.ok, false)
    assert.equal(res.verdict, 'DEPLOY_FAILED')
    assert.ok(ui.notes.some((n) => n.title === 'Partial Deployment Failure & Recovery'))
    assert.ok(ui.notes.some((n) => n.title === 'Detailed Failure Report'))
    assert.ok(ui.notes.some((n) => n.title === 'Reconciled Remote State'))
    const recNote = ui.notes.find((n) => n.title === 'Reconciled Remote State')
    assert.match(recNote.msg, /Writer Token: UNKNOWN \(HTTP 403\)/)
    assert.equal(res.result.inventory.publicBaseUrl, null)
    assert.equal(res.result.inventory.deployment.deployedAt, null)
    assert.ok(res.result.inventory.deployment.attemptedAt)
  } finally {
    rmSync(invDir, { recursive: true, force: true })
  }
})

test('Regression F7: failed sync leaves bucket state sync-outcome-unknown-and-private rather than verified-empty-and-private (#208)', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { main: wizardMain } = await import('./setup-wizard.mjs')
  const invDir = mkdtempSync(join(tmpdir(), 'wizard-f7-sync-'))
  try {
    const fetchFake = fakeFetch([
      [/\/user\/tokens\/verify$/, () => ({ body: { success: true, result: { id: 'tok', status: 'active' } } })],
      [/\/user\/tokens\/permissions$/, () => ({ body: { success: true, result: { permissions: ['User API Tokens:Edit'] } } })],
      [/\/user\/tokens$/, () => ({ status: 200, body: { success: true, result: [] } })],
      [/\/accounts$/, () => ({ body: { success: true, result: [{ id: ACCOUNT, name: 'Test Account' }] } })],
      [/\/accounts\/[^/]+\/workers\/subdomain$/, () => ({ body: { success: true, result: { subdomain: 'testsub' } } })],
      [/\/workers\/scripts$/, () => ({ body: { success: true, result: [] } })],
      [/\/accounts\/[^/]+\/r2\/buckets$/, () => ({ body: { success: true, result: { buckets: [] } } })],
      [/\/zones/, () => ({ body: { success: true, result: [] } })],
      [/api\.bgm\.tv\/v0\/me$/, () => ({ body: { id: 123, username: 'tester' } })],
      [/users\/tester\/collections/, () => ({ body: { total: 1, data: [{ subject_id: 9 }] } })],
      [/\-\/collections\/9\/episodes/, () => ({ body: { total: 1, data: [] } })],
    ])
    const ui = makeScriptedUi([
      { type: 'select', match: /AiringCal Setup/, value: 'install' },
      { type: 'select', match: /Environment/, value: 'production' },
      { type: 'password', match: /Cloudflare API Token/, value: 'cf-tok' },
      { type: 'password', match: /Bangumi Personal Access Token/, value: 'bgm-tok' },
      { type: 'confirm', match: /Custom Domain/, value: false },
      { type: 'select', match: /Review Configuration/, value: 'install' },
      { type: 'confirm', match: /Install AiringCal in Production now/, value: true },
      { type: 'confirm', match: /Run the First Full Sync now/, value: true },
      { type: 'confirm', match: /Dispatch the Writer/, value: true },
    ])
    const res = await wizardMain([], {
      env: { ...process.env, AIRINGCAL_INVENTORY_DIR: invDir },
      fetchImpl: fetchFake.impl,
      spawnSyncImpl: () => ({ status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }),
      ui,
      log: () => {},
      hooks: {
        preflight: async () => {},
        createApplyIo: () => ({
          s3Credentials: () => ({ accessKeyId: 'k', secretAccessKey: 's', source: 'scoped-token', scope: 'bucket-scoped' }),
          probeToken: async () => ({ ok: true }),
          deriveAndVerifyS3: async (ctx) => { ctx.writerCredentialDeferred = true; return { deferred: true } },
          ensureBucket: async (ctx) => {
            ctx.ledger.begin({ op: 'r2-bucket-create', stepId: 'ensure-bucket', resourceType: 'r2-bucket', target: 'airingcal-production' }).confirm('created')
            return { bucket: 'airingcal-production', created: true }
          },
          provisionProductionWriter: async () => ({ verified: true }),
          verifyBucketEmpty: async () => ({ emptyVerified: true }),
          disableR2Dev: async () => ({ disabled: true }),
          syncGithubEnvironment: async () => ({ environment: 'production' }),
          deployCloudflareReader: async () => ({ deployed: true, workerUrl: 'https://airingcal-production.testsub.workers.dev' }),
          verifyImageRouting: async () => ({ status: 'skipped-no-release' }),
          validateImageCdn: async () => ({ enabled: false }),
          writeIsolationProbe: async () => ({ key: 'checkpoints/_isolation-probe.txt', body: 'isolation-probe', exists: true }),
          probeAnonymousAccess: async () => ({
            r2DevDisabled: true,
            probes: [
              { url: 'https://airingcal-production.testsub.workers.dev/checkpoints/_isolation-probe.txt', method: 'GET', status: 404 },
              { url: 'https://airingcal-production.testsub.workers.dev/checkpoints/_isolation-probe.txt', method: 'HEAD', status: 404 },
            ],
          }),
          deleteIsolationProbe: async () => ({ key: 'checkpoints/_isolation-probe.txt', deleted: true }),
        }),
        syncRunner: async () => {
          throw new Error('workflow restoration failed after dispatch')
        },
      },
    })
    assert.equal(res.verdict, 'SYNC_FAILED')
    assert.equal(res.result.inventory.resources.bucket.state, 'sync-outcome-unknown-and-private')
  } finally {
    rmSync(invDir, { recursive: true, force: true })
  }
})
