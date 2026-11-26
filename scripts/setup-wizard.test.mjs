import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { applyPlan, discoverIdentity, planCustomDomain, runFirstSync, writeInventory } from './setup-wizard.mjs'
import {
  assertInventorySanitized,
  buildInventory,
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
  const { impl, calls } = scriptedSpawn([
    [/^gh auth status/, () => ({})],
    [/^gh api repos\/Skyline-Gazer\/AiringCal\/git\/ref\/heads\/dev/, () => ({ stdout: `${sha}\n` })],
    [/^gh workflow list/, () => ({ stdout: JSON.stringify([{ id: 407881922, name: 'Portable writer (GHA)', state: 'disabled_manually' }]) })],
    [/^gh variable get AIRINGCAL_WRITER_ENABLED/, () => ({ status: 1, stdout: '' })],
    [/^gh workflow enable/, () => ({})],
    [/^gh variable set AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED --env production --repo .* --body true/, () => ({})],
    [/^gh workflow run portable-writer.yml/, () => ({})],
    [/^gh run list/, () => ({ stdout: JSON.stringify([{ databaseId: 555, headSha: sha, createdAt: new Date(Date.now()).toISOString(), url: 'https://example/runs/555' }]) })],
    [/^gh run view 555/, (() => {
      let polls = 0
      return () => {
        polls += 1
        const completed = polls > 1
        return {
          stdout: JSON.stringify({
            status: completed ? 'completed' : 'in_progress',
            conclusion: completed ? 'success' : null,
            jobs: [{ steps: [{ name: 'Production bootstrap gate (fails closed)', conclusion: 'success' }] }],
          }),
        }
      }
    })()],
    [/^gh variable set AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED --env production --repo .* --body false/, () => ({})],
    [/^gh workflow disable/, () => ({})],
  ])
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
  const { impl, calls } = scriptedSpawn([
    [/^gh auth status/, () => ({})],
    [/^gh api repos/, () => ({ stdout: `${sha}\n` })],
    [/^gh workflow list/, () => ({ stdout: JSON.stringify([{ id: 7, name: 'Portable writer (GHA)', state: 'active' }]) })],
    [/^gh variable get AIRINGCAL_WRITER_ENABLED/, () => ({ status: 1 })],
    [/^gh variable set AIRINGCAL_DEVELOPMENT_WRITER_ENABLED .* --body true/, () => ({})],
    [/^gh workflow run/, () => ({})],
    [/^gh run list/, () => ({ stdout: JSON.stringify([{ databaseId: 777, headSha: sha, createdAt: new Date(Date.now()).toISOString(), url: 'u' }]) })],
    [/^gh run view 777/, () => ({
      stdout: JSON.stringify({ status: 'completed', conclusion: 'failure', jobs: [{ steps: [{ name: 'Development writer gate (fails closed)', conclusion: 'failure' }] }] }),
    })],
    [/^gh variable set AIRINGCAL_DEVELOPMENT_WRITER_ENABLED .* --body false/, () => ({})],
  ])
  await assert.rejects(
    () => runFirstSync({ environment: 'development', expectedSha: sha, spawnSyncImpl: impl, log: () => {}, sleep: async () => {} }),
    /gate step/,
  )
  assert.ok(calls.some((c) => c.key.includes('AIRINGCAL_DEVELOPMENT_WRITER_ENABLED') && c.key.includes('--body false')),
    'gate closed in cleanup')
})

test('runFirstSync refuses a remote head that does not match the expected SHA (#195)', async () => {
  const { impl } = scriptedSpawn([
    [/^gh auth status/, () => ({})],
    [/^gh api repos/, () => ({ stdout: `${'c'.repeat(40)}\n` })],
  ])
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
  const { impl, calls } = scriptedSpawn([
    [/^gh auth status/, () => ({})],
    [/^gh api repos/, () => ({ stdout: `${sha}\n` })],
    [/^gh workflow list/, () => ({ stdout: JSON.stringify([{ id: 9, name: 'Portable writer (GHA)', state: 'disabled_manually' }]) })],
    [/^gh variable get AIRINGCAL_WRITER_ENABLED/, () => ({ status: 0, stdout: 'true\n' })],
  ])
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
