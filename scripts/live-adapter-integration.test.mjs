import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildProductionPlan, mutationsExecutedFrom, runProductionApply } from './deploy-env-lib.mjs'
import { createLiveDevelopmentApplyIo } from './deploy-env-live-io.mjs'
import {
  DEFAULT_ACCOUNT_ID,
  SECONDARY_ACCOUNT_ID,
  createControlledProviderSimulator,
} from './fixtures/controlled-provider-sim.mjs'
import { main as wizardMain, readInventory } from './setup-wizard.mjs'

function makeProdEnv(overrides = {}) {
  return {
    AIRINGCAL_ENV: 'production',
    AIRINGCAL_DEPLOY_TARGET: 'cloudflare',
    AIRINGCAL_CLOUDFLARE_API_TOKEN: 'cf-mgmt-sim-token',
    AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: DEFAULT_ACCOUNT_ID,
    AIRINGCAL_BANGUMI_TOKEN: 'bgm-pat-sim-token',
    AIRINGCAL_PRIMARY_USER_ID: '901234',
    AIRINGCAL_USERS_JSON: '[{"userId":"901234","username":"sim-owner"}]',
    AIRINGCAL_WORKERS_DEV_SUBDOMAIN: 'primary-sim',
    AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED: 'yes',
    AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    ...overrides,
  }
}

function makeProdPlan(overrides = {}) {
  return buildProductionPlan({
    target: 'cloudflare',
    publicBaseUrl: '',
    mode: 'apply',
    accountId: DEFAULT_ACCOUNT_ID,
    workersDevSubdomain: 'primary-sim',
    applyAuthorized: true,
    gitSha: 'a'.repeat(40),
    ...overrides,
  })
}

function createSimIo(sim, env = makeProdEnv(), plan = makeProdPlan()) {
  return createLiveDevelopmentApplyIo({
    env,
    plan,
    fetchImpl: sim.fetchImpl,
    spawnSyncImpl: sim.spawnSyncImpl,
    createObjectStore: sim.createObjectStore,
    sleepImpl: async () => {},
  })
}

function createScriptedUi(scripted) {
  const notes = []
  const logs = []
  const nextAnswer = (kind, message) => {
    const idx = scripted.findIndex((step) => step.type === kind && (!step.match || step.match.test(message)))
    if (idx === -1) throw new Error(`Unexpected prompt (${kind}): ${message}`)
    const [step] = scripted.splice(idx, 1)
    return step.value
  }
  return {
    notes,
    logs,
    interactive: true,
    color: false,
    theme: 'auto',
    prompts: {
      select: async ({ message }) => nextAnswer('select', message),
      confirm: async (arg) => nextAnswer('confirm', typeof arg === 'string' ? arg : arg.message),
      text: async ({ message }) => nextAnswer('text', message),
      password: async ({ message }) => nextAnswer('password', message),
    },
    select: async (arg) => nextAnswer('select', typeof arg === 'string' ? arg : arg.message),
    confirm: async (arg) => nextAnswer('confirm', typeof arg === 'string' ? arg : arg.message),
    text: async (arg) => nextAnswer('text', typeof arg === 'string' ? arg : arg.message),
    password: async (arg) => nextAnswer('password', typeof arg === 'string' ? arg : arg.message),
    log: {
      info: (m) => logs.push(['info', m]),
      step: (m) => logs.push(['step', m]),
      success: (m) => logs.push(['success', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    spinner: () => ({ start() {}, stop() {}, fail() {} }),
    intro() {},
    outro() {},
    cancel() {},
    note(msg, title) { notes.push({ title, msg }) },
    link(label, url) { return `${label}: ${url}` },
  }
}

// ===========================================================================
// QA-002 Coverage Matrix (12 scenarios) using real runProductionApply +
// real createLiveDevelopmentApplyIo + Controlled Provider Simulator
// ===========================================================================

test('QA-002 #1: target bucket absent -> two-token automatic Writer provisioning succeeds in exact dependency order', async () => {
  const sim = createControlledProviderSimulator()
  const beforeUnrelated = sim.snapshotUnrelatedBuckets()
  const env = makeProdEnv()
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.writerCredentialState, 'provisioned-verified')
  assert.equal(sim.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), true)
  assert.equal(sim.getBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production').r2DevEnabled, false)
  assert.deepEqual(sim.listObjects(DEFAULT_ACCOUNT_ID, 'airingcal-production'), [], 'isolation probe cleaned up')
  assert.deepEqual(sim.snapshotUnrelatedBuckets(), beforeUnrelated)

  const bucketIdx = result.completed.indexOf('ensure-bucket')
  const writerIdx = result.completed.indexOf('provision-writer-credential')
  const emptyIdx = result.completed.indexOf('verify-bucket-empty')
  const ghIdx = result.completed.indexOf('sync-gh-env')
  const deployIdx = result.completed.indexOf('deploy-cloudflare')
  const probeIdx = result.completed.indexOf('isolation-probe-write')
  assert.ok(bucketIdx >= 0 && writerIdx > bucketIdx && emptyIdx > writerIdx && ghIdx > emptyIdx && deployIdx > ghIdx && probeIdx > deployIdx)
  assert.equal(result.completed.includes('derive-s3'), false, 'deferred path never marks derive-s3 complete')

  const executed = mutationsExecutedFrom(result.completed, result.mutations)
  for (const op of ['r2-bucket-create', 'writer-token-create', 'r2-dev-disable', 'github-environment-ensure', 'worker-deploy', 'isolation-probe-write', 'isolation-probe-delete']) {
    assert.ok(executed.includes(op), `expected ${op} in mutationsExecuted`)
  }
})

test('QA-002 #2: target bucket already exists and is empty (explicit adoption) succeeds', async () => {
  const sim = createControlledProviderSimulator()
  sim.seedBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production', { objects: {}, r2DevEnabled: true })
  const env = makeProdEnv()
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io, bucketAdoptionAuthorized: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  const bucketEntry = result.mutations.find((m) => m.op === 'r2-bucket-create')
  assert.equal(bucketEntry.status, 'already-exists')
})

test('QA-002 #3 & BUG-004 #1: bucket creation succeeds, token provisioning fails -> bucket persisted & accurately accounted', async () => {
  const sim = createControlledProviderSimulator({ faults: { tokenCreateStatus: 403 } })
  const env = makeProdEnv()
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, false)
  assert.equal(result.errorCategory, 'permission-denied')
  assert.equal(sim.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), true)
  const bucketEntry = result.mutations.find((m) => m.op === 'r2-bucket-create')
  assert.equal(bucketEntry.status, 'confirmed-success')
  const tokenEntry = result.mutations.find((m) => m.op === 'writer-token-create')
  assert.equal(tokenEntry.status, 'confirmed-failed')
  assert.ok(result.mutationsExecuted.includes('r2-bucket-create'))
  assert.equal(result.mutationsExecuted.includes('writer-token-create'), false)
})

test('QA-002 #4: token provisioning unavailable, masked independent S3 fallback succeeds', async () => {
  const sim = createControlledProviderSimulator({ faults: { permissionsMode: 'denied' } })
  sim.addOperatorS3Override({
    accessKeyId: 'op-s3-key-1',
    secretAccessKey: 'op-s3-secret-1',
    allowedBuckets: ['airingcal-production'],
  })
  const env = makeProdEnv({
    AIRINGCAL_S3_ACCESS_KEY_ID: 'op-s3-key-1',
    AIRINGCAL_S3_SECRET_ACCESS_KEY: 'op-s3-secret-1',
  })
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.writerCredentialState, 'override-verified')
  assert.equal(io.s3Credentials().source, 'operator-override')
  assert.ok(result.completed.includes('derive-s3'))
  assert.ok(result.completed.includes('verify-bucket-empty'))
  assert.equal(result.completed.includes('provision-writer-credential'), false)
})

test('QA-002 #5: invalid S3 fallback is rejected cleanly in Production without silent fallback', async () => {
  const sim = createControlledProviderSimulator()
  const env = makeProdEnv({
    AIRINGCAL_S3_ACCESS_KEY_ID: 'invalid-key',
    AIRINGCAL_S3_SECRET_ACCESS_KEY: 'invalid-secret',
  })
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'S3_OVERRIDE_REJECTED')
  assert.equal(result.errorCategory, 'permission-denied')
  assert.equal(sim.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), false)
  assert.deepEqual(result.mutationsExecuted, [])
})

test('QA-002 #6: nonempty bucket fails clean-bootstrap check before downstream mutations; foreign objects untouched', async () => {
  const sim = createControlledProviderSimulator()
  sim.seedBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production', {
    objects: { 'foreign/data.json': '{"foreign":true}' },
    r2DevEnabled: true,
  })
  const env = makeProdEnv()
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io, bucketAdoptionAuthorized: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BUCKET_NOT_EMPTY')
  assert.equal(result.errorCategory, 'resource-conflict')
  assert.equal(result.completed.includes('disable-r2-dev'), false)
  assert.equal(result.completed.includes('sync-gh-env'), false)
  assert.equal(sim.hasGithubEnv('production'), false)
  assert.deepEqual(sim.listObjects(DEFAULT_ACCOUNT_ID, 'airingcal-production'), ['foreign/data.json'])
  assert.equal(sim.state.mintedTokens.size, 0, 'freshly minted writer token must be deleted on dirty-bucket abort')
  assert.equal(sim.state.deletedTokens.length, 1)
  assert.ok(result.mutationsSummary.compensations.some((e) => e.op === 'writer-token-cleanup'))
})

test('QA-002 #7: existing bucket ownership unproven without inventory match or explicit adoption -> refuses safely', async () => {
  const sim = createControlledProviderSimulator()
  sim.seedBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production', { objects: {}, r2DevEnabled: true })
  const env = makeProdEnv()
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BUCKET_OWNERSHIP_UNPROVEN')
  assert.equal(result.errorCategory, 'resource-conflict')
  assert.equal(sim.state.mintedTokens.size, 0, 'must not mint tokens before ownership proof')
})

test('QA-002 #8 & BUG-004 #2: token scope broader than intended -> token deleted and apply aborted', async () => {
  const sim = createControlledProviderSimulator({ faults: { broadTokenScope: true } })
  const env = makeProdEnv()
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'WRITER_SCOPE_VIOLATION')
  assert.equal(result.errorCategory, 'scope-violation')
  assert.equal(sim.state.mintedTokens.size, 0, 'broad token deleted')
  assert.equal(sim.state.deletedTokens.length, 1)
  assert.ok(result.mutationsSummary.confirmed.some((e) => e.op === 'r2-bucket-create'))
  assert.ok(result.mutationsSummary.confirmed.some((e) => e.op === 'writer-token-create'))
  assert.ok(result.mutationsSummary.compensations.some((e) => e.op === 'writer-token-cleanup'))
})

test('QA-002 #9: credential readback fails -> token deleted and error classified as transport-failure (not missing permission)', async () => {
  const sim = createControlledProviderSimulator({ faults: { tokenReadbackError: 'http-500' } })
  const env = makeProdEnv()
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'WRITER_READBACK_FAILED')
  assert.equal(result.errorCategory, 'transport-failure')
  assert.equal(result.missingScopes, undefined, 'transport readback failure must not be mislabeled as missing permission')
  assert.equal(sim.state.mintedTokens.size, 0)
})

test('QA-002 #10: partial mutation recovery -> attempt 1 creates bucket and fails; attempt 2 recovers via inventory match', async () => {
  const sim = createControlledProviderSimulator({ faults: { tokenCreateStatus: 403 } })
  const env = makeProdEnv()
  const plan = makeProdPlan()

  // Attempt 1: creates bucket then fails token provisioning
  const attempt1 = await runProductionApply({ plan, env, io: createSimIo(sim, env, plan) })
  assert.equal(attempt1.ok, false)
  assert.equal(sim.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), true)
  assert.ok(attempt1.mutationsExecuted.includes('r2-bucket-create'))

  // Attempt 2: token creation permission fixed; prior inventory matches account+bucket -> safe reuse without deletion
  sim.state.faults.tokenCreateStatus = null
  const priorInventory = {
    schema: 'airingcal.inventory.v1',
    environment: 'production',
    bucket: 'airingcal-production',
    cloudflare: { accountId: DEFAULT_ACCOUNT_ID },
    mutationReceipts: [{ status: 'aborted', mutationsExecuted: ['r2-bucket-create'] }],
  }
  const attempt2 = await runProductionApply({ plan, env, io: createSimIo(sim, env, plan), priorInventory })
  assert.equal(attempt2.ok, true, JSON.stringify(attempt2))
  assert.equal(attempt2.mutations.find((m) => m.op === 'r2-bucket-create').status, 'already-exists')
  assert.equal(attempt2.writerCredentialState, 'provisioned-verified')
})

test('QA-002 #11: wrong-account resource selection fails closed before any mutation', async () => {
  const sim = createControlledProviderSimulator({
    extraAccounts: [{ id: SECONDARY_ACCOUNT_ID, name: 'Other Account', subdomain: 'other' }],
    accessibleAccountIds: [DEFAULT_ACCOUNT_ID], // token cannot access SECONDARY_ACCOUNT_ID
  })
  const env = makeProdEnv({ AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: SECONDARY_ACCOUNT_ID })
  const plan = makeProdPlan({ accountId: SECONDARY_ACCOUNT_ID })
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'WRONG_ACCOUNT')
  assert.equal(result.errorCategory, 'resource-conflict')
  assert.equal(sim.hasBucket(SECONDARY_ACCOUNT_ID, 'airingcal-production'), false)
  assert.equal(sim.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), false)
  assert.deepEqual(result.mutationsExecuted, [])
})

test('QA-002 #12: unrelated buckets in the same account remain completely untouched across full apply', async () => {
  const sim = createControlledProviderSimulator()
  const before = sim.snapshotUnrelatedBuckets()
  const env = makeProdEnv()
  const plan = makeProdPlan()

  const result = await runProductionApply({ plan, env, io: createSimIo(sim, env, plan) })
  assert.equal(result.ok, true)
  assert.deepEqual(sim.snapshotUnrelatedBuckets(), before)
})

// ===========================================================================
// BUG-004 Failure Injection Scenarios & Error Classification
// ===========================================================================

test('BUG-004 #3: token created, scope check fails AND token cleanup fails -> unverified cleanup accounted', async () => {
  const sim = createControlledProviderSimulator({
    faults: { broadTokenScope: true, tokenCleanupFail: true },
  })
  const env = makeProdEnv()
  const plan = makeProdPlan()

  const result = await runProductionApply({ plan, env, io: createSimIo(sim, env, plan) })
  assert.equal(result.ok, false)
  assert.equal(result.cleanupFailed, true)
  assert.equal(result.mutationsSummary.unverifiedCleanups.length, 1)
  assert.equal(result.mutationsSummary.unverifiedCleanups[0].op, 'writer-token-cleanup')
  assert.equal(result.mutationsSummary.unverifiedCleanups[0].status, 'compensation-failed')
  assert.match(result.mutationsSummary.unverifiedCleanups[0].reconciliationHint, /Manually inspect and delete/)
  assert.equal(sim.state.mintedTokens.size, 1, 'orphan token remains observable in provider state')
})

test('BUG-004 #4: GitHub Environment created, later variable set fails -> env creation preserved in ledger', async () => {
  const sim = createControlledProviderSimulator({
    faults: { ghVarSetFailAt: 'AIRINGCAL_PRODUCTION_R2_BUCKET' },
  })
  const env = makeProdEnv()
  const plan = makeProdPlan()

  const result = await runProductionApply({ plan, env, io: createSimIo(sim, env, plan) })
  assert.equal(result.ok, false)
  assert.equal(sim.hasGithubEnv('production'), true)
  assert.ok(result.mutationsSummary.confirmed.some((e) => e.op === 'github-environment-ensure'))
  assert.ok(result.mutationsSummary.confirmed.some((e) => e.op === 'github-variable-set'))
  assert.ok(result.mutationsSummary.failed.some((e) => e.op === 'github-variable-set'))
})

test('BUG-004 #5: Worker deployed, isolation verification fails -> worker deploy & probe write/delete preserved', async () => {
  const sim = createControlledProviderSimulator({
    faults: { isolationLeakStatus: 200 },
  })
  const env = makeProdEnv()
  const plan = makeProdPlan()

  const result = await runProductionApply({ plan, env, io: createSimIo(sim, env, plan) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ISOLATION_FAILED')
  assert.ok(result.mutationsSummary.confirmed.some((e) => e.op === 'worker-deploy'))
  assert.ok(result.mutationsSummary.confirmed.some((e) => e.op === 'isolation-probe-write'))
  assert.ok(result.mutationsSummary.compensations.some((e) => e.op === 'isolation-probe-delete'))
})

test('BUG-004 #6: remote operation succeeds in provider state, response lost -> unknown-outcome recorded with hint', async () => {
  const sim = createControlledProviderSimulator({ faults: { bucketCreateLostResponse: true } })
  const env = makeProdEnv()
  const plan = makeProdPlan()

  const result = await runProductionApply({ plan, env, io: createSimIo(sim, env, plan) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BUCKET_CREATE_AMBIGUOUS')
  assert.equal(result.errorCategory, 'transport-failure')
  assert.equal(sim.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), true)
  assert.equal(result.mutationsSummary.unknown.length, 1)
  assert.equal(result.mutationsSummary.unknown[0].op, 'r2-bucket-create')
  assert.ok(result.mutationsExecuted.includes('r2-bucket-create'))
  assert.match(result.mutationsSummary.unknown[0].reconciliationHint, /Reconcile|wrangler r2 bucket info/i)

  const simTok = createControlledProviderSimulator({ faults: { tokenCreateLostResponse: true } })
  const tokRes = await runProductionApply({ plan, env, io: createSimIo(simTok, env, plan) })
  assert.equal(tokRes.ok, false)
  assert.equal(tokRes.code, 'WRITER_TOKEN_CREATE_AMBIGUOUS')
  assert.equal(tokRes.mutationsSummary.unknown.length, 1)
  assert.equal(tokRes.mutationsSummary.unknown[0].op, 'writer-token-create')
  assert.equal(simTok.state.mintedTokens.size, 1)
})

test('BUG-004 #7: isolation probe written, HEAD fails -> probe deleted in finally and both accounted; delete failure stays compensation-failed', async () => {
  const sim = createControlledProviderSimulator({ faults: { s3HeadFailAfterWrite: true } })
  const env = makeProdEnv()
  const plan = makeProdPlan()

  const res1 = await runProductionApply({ plan, env, io: createSimIo(sim, env, plan) })
  assert.equal(res1.ok, false)
  assert.ok(res1.mutationsSummary.confirmed.some((e) => e.op === 'isolation-probe-write'))
  assert.ok(res1.mutationsSummary.compensations.some((e) => e.op === 'isolation-probe-delete'))
  assert.deepEqual(sim.listObjects(DEFAULT_ACCOUNT_ID, 'airingcal-production'), [])

  const sim2 = createControlledProviderSimulator({ faults: { s3HeadFailAfterWrite: true, s3DeleteFail: true } })
  const res2 = await runProductionApply({ plan, env, io: createSimIo(sim2, env, plan) })
  assert.equal(res2.ok, false)
  assert.equal(res2.cleanupFailed, true)
  assert.ok(res2.mutationsSummary.unverifiedCleanups.some((e) => e.op === 'isolation-probe-delete'))
  assert.deepEqual(sim2.listObjects(DEFAULT_ACCOUNT_ID, 'airingcal-production'), ['checkpoints/_isolation-probe.txt'])
})

test('BUG-003 error classification: missing permission catalogue never blocks or fakes verified; missing group is provider-incompatibility', async () => {
  const simUnknownCat = createControlledProviderSimulator({ faults: { permissionsMode: 'empty' } })
  const resOk = await runProductionApply({ plan: makeProdPlan(), env: makeProdEnv(), io: createSimIo(simUnknownCat) })
  assert.equal(resOk.ok, true, 'empty/inconclusive catalogue still lets authoritative POST succeed')

  const simNoGroup = createControlledProviderSimulator({ faults: { permissionGroupMissing: true } })
  const resGroup = await runProductionApply({ plan: makeProdPlan(), env: makeProdEnv(), io: createSimIo(simNoGroup) })
  assert.equal(resGroup.ok, false)
  assert.equal(resGroup.errorCategory, 'provider-incompatibility')
  assert.equal(resGroup.code, 'PERMISSION_GROUP_MISSING')
  assert.equal(resGroup.missingScopes, undefined)
})

test('Wizard end-to-end partial Production recovery via real setup-wizard.mjs + real Live I/O Adapter', async () => {
  const invDir = mkdtempSync(join(tmpdir(), 'wizard-live-sim-'))
  try {
    // Seed partial state matching the c6fd64ff incident: bucket exists, inventory shows DEPLOY_FAILED
    const sim = createControlledProviderSimulator()
    sim.seedBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production', {
      objects: {},
      creationDate: '2026-11-26T10:36:40.000Z',
    })
    writeFileSync(
      join(invDir, 'inventory.production.json'),
      JSON.stringify({
        schema: 'airingcal.inventory.v1',
        environment: 'production',
        bucket: 'airingcal-production',
        cloudflare: { accountId: DEFAULT_ACCOUNT_ID, accountName: "user@example.com's Account" },
        deployment: { gitSha: 'c6fd64fffee42bbc956f3660c3a6798ac23481ef', deployedAt: '2026-11-26T10:36:42.311Z', verdict: 'DEPLOY_FAILED' },
        mutationReceipts: [{ status: 'aborted', completed: ['token-probe', 'derive-s3'], mutationsExecuted: [] }],
      }),
      { mode: 0o600 },
    )

    const ui = createScriptedUi([
      { type: 'select', match: /AiringCal Setup/, value: 'validate' },
      { type: 'password', match: /Cloudflare API Token/, value: 'cf-mgmt-sim-token' },
      { type: 'password', match: /Bangumi Personal Access Token/, value: 'bgm-pat-sim-token' },
      { type: 'select', match: /Next Action/, value: 'install' },
      { type: 'select', match: /Environment/, value: 'production' },
      { type: 'confirm', match: /Custom Domain/, value: false },
      { type: 'confirm', match: /Adopt existing bucket "airingcal-production"/, value: true },
      { type: 'select', match: /Review Configuration/, value: 'install' },
      { type: 'confirm', match: /Install AiringCal in Production now/, value: true },
      { type: 'confirm', match: /Run the First Full Sync now/, value: false },
    ])

    const logs = []
    const res = await wizardMain([], {
      env: { ...process.env, AIRINGCAL_INVENTORY_DIR: invDir },
      fetchImpl: sim.fetchImpl,
      spawnSyncImpl: sim.spawnSyncImpl,
      ui,
      log: (line) => logs.push(line),
      hooks: {
        preflight: async () => {},
        createApplyIo: ({ env, plan }) => createLiveDevelopmentApplyIo({
          env,
          plan,
          fetchImpl: sim.fetchImpl,
          spawnSyncImpl: sim.spawnSyncImpl,
          createObjectStore: sim.createObjectStore,
          sleepImpl: async () => {},
        }),
      },
    })

    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.verdict, 'AWAITING_FIRST_SYNC')
    assert.equal(res.result.inventory.writerCredentialState, 'provisioned-verified')
    assert.equal(res.result.inventory.deployment.verdict, 'AWAITING_FIRST_SYNC')
    assert.ok(res.result.inventory.deployment.attemptedAt)
    assert.ok(res.result.inventory.deployment.deployedAt)
    assert.equal(sim.hasGithubEnv('production'), true)
    assert.equal(sim.getBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production').r2DevEnabled, false)
    const persisted = JSON.parse(readFileSync(join(invDir, 'inventory.production.json'), 'utf8'))
    assert.equal(persisted.writerCredential.tokenName, 'airingcal-production-writer')
    assert.equal(JSON.stringify(persisted).includes('cf-mgmt-sim-token'), false)
    assert.equal(JSON.stringify(persisted).includes('bgm-pat-sim-token'), false)
    assert.ok(readInventory({ environment: 'production', env: { AIRINGCAL_INVENTORY_DIR: invDir } }))
  } finally {
    rmSync(invDir, { recursive: true, force: true })
  }
})

// ===========================================================================
// Independent Review Regression Tests (#208 Findings 1-7 + Focus Area 7)
// ===========================================================================

test('Regression F1: /user/tokens/permissions 404/500/unrecognized stays advisory, while explicit denial aborts', async () => {
  for (const mode of ['not-found', 'server-error', 'unrecognized']) {
    const sim = createControlledProviderSimulator({ faults: { permissionsMode: mode } })
    const res = await runProductionApply({ plan: makeProdPlan(), env: makeProdEnv(), io: createSimIo(sim) })
    assert.equal(res.ok, true, `mode=${mode} must remain advisory: ${JSON.stringify(res)}`)
  }

  const simDenied = createControlledProviderSimulator({ faults: { permissionsMode: 'denied' } })
  const resDenied = await runProductionApply({ plan: makeProdPlan(), env: makeProdEnv(), io: createSimIo(simDenied) })
  assert.equal(resDenied.ok, false)
  assert.equal(resDenied.errorCategory, 'permission-denied')
  assert.ok(Array.isArray(resDenied.missingScopes) && resDenied.missingScopes.length > 0)
})

test('Regression F2: prior DEPLOY_FAILED inventory with mutationsExecuted: [] does NOT prove bucket ownership', async () => {
  const sim = createControlledProviderSimulator()
  sim.seedBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production', { objects: {}, r2DevEnabled: true })
  const priorInventory = {
    schema: 'airingcal.inventory.v1',
    environment: 'production',
    bucket: 'airingcal-production',
    cloudflare: { accountId: DEFAULT_ACCOUNT_ID },
    deployment: { gitSha: 'c6fd64fffee42bbc956f3660c3a6798ac23481ef', verdict: 'DEPLOY_FAILED' },
    mutationReceipts: [{ status: 'aborted', mutationsExecuted: [] }],
  }
  const resRefused = await runProductionApply({ plan: makeProdPlan(), env: makeProdEnv(), io: createSimIo(sim), priorInventory })
  assert.equal(resRefused.ok, false)
  assert.equal(resRefused.code, 'BUCKET_OWNERSHIP_UNPROVEN')
  assert.equal(sim.state.mintedTokens.size, 0)

  const missingAcctReady = {
    schema: 'airingcal.inventory.v1',
    environment: 'production',
    bucket: 'airingcal-production',
    deployment: { gitSha: 'c6fd64fffee42bbc956f3660c3a6798ac23481ef', verdict: 'READY' },
    mutationReceipts: [{ status: 'applied', mutationsExecuted: ['r2-bucket-create'] }],
  }
  const resMissingAcct = await runProductionApply({
    plan: makeProdPlan(),
    env: makeProdEnv(),
    io: createSimIo(sim),
    priorInventory: missingAcctReady,
  })
  assert.equal(resMissingAcct.ok, false)
  assert.equal(resMissingAcct.code, 'BUCKET_OWNERSHIP_UNPROVEN')
  assert.equal(sim.state.mintedTokens.size, 0)

  const resAdopted = await runProductionApply({
    plan: makeProdPlan(),
    env: makeProdEnv(),
    io: createSimIo(sim),
    priorInventory,
    bucketAdoptionAuthorized: true,
  })
  assert.equal(resAdopted.ok, true, JSON.stringify(resAdopted))
})

test('Regression F3: POST /user/tokens missing value confirms & deletes orphan; missing id+value records unknown-outcome', async () => {
  const simNoVal = createControlledProviderSimulator({ faults: { tokenCreateMissingValue: true } })
  const resNoVal = await runProductionApply({ plan: makeProdPlan(), env: makeProdEnv(), io: createSimIo(simNoVal) })
  assert.equal(resNoVal.ok, false)
  assert.equal(resNoVal.code, 'WRITER_TOKEN_BAD_RESPONSE')
  assert.equal(simNoVal.state.mintedTokens.size, 0, 'incomplete token without value must be cleaned up')
  assert.equal(simNoVal.state.deletedTokens.length, 1)
  assert.ok(resNoVal.mutationsSummary.confirmed.some((e) => e.op === 'writer-token-create'))
  assert.ok(resNoVal.mutationsSummary.compensations.some((e) => e.op === 'writer-token-cleanup'))

  const simNoBoth = createControlledProviderSimulator({ faults: { tokenCreateMissingIdAndValue: true } })
  const resNoBoth = await runProductionApply({ plan: makeProdPlan(), env: makeProdEnv(), io: createSimIo(simNoBoth) })
  assert.equal(resNoBoth.ok, false)
  assert.equal(resNoBoth.code, 'WRITER_TOKEN_BAD_RESPONSE')
  assert.ok(resNoBoth.mutationsSummary.unknown.some((e) => e.op === 'writer-token-create'))

  const simNoId = createControlledProviderSimulator({ faults: { tokenCreateMissingId: true } })
  const resNoId = await runProductionApply({ plan: makeProdPlan(), env: makeProdEnv(), io: createSimIo(simNoId) })
  assert.equal(resNoId.ok, false)
  assert.equal(resNoId.code, 'WRITER_TOKEN_BAD_RESPONSE')
  assert.equal(resNoId.errorCategory, 'provider-incompatibility')
  assert.ok(resNoId.mutationsSummary.unknown.some((e) => e.op === 'writer-token-create'))
  assert.equal(simNoId.state.deletedTokens.length, 0)
  assert.equal(JSON.stringify(resNoId).includes('sim-writer-secret-val-'), false)
})

test('Regression FA7: S3 override before bucket creation starts override-pending-bucket and reaches override-verified only after empty check', async () => {
  const sim = createControlledProviderSimulator({ faults: { permissionsMode: 'denied' } })
  sim.addOperatorS3Override({
    accessKeyId: 'op-s3-pending',
    secretAccessKey: 'op-s3-pending-secret',
    allowedBuckets: ['airingcal-production'],
  })
  const env = makeProdEnv({
    AIRINGCAL_S3_ACCESS_KEY_ID: 'op-s3-pending',
    AIRINGCAL_S3_SECRET_ACCESS_KEY: 'op-s3-pending-secret',
  })
  const plan = makeProdPlan()
  const io = createSimIo(sim, env, plan)
  const ctx = {}
  const initialDerive = await io.deriveAndVerifyS3(ctx)
  assert.equal(initialDerive.verified, false)
  assert.equal(initialDerive.pendingBucketAccessProof, true)

  // When bucket does not exist yet and verifyBucketEmpty fails after creation,
  // state must remain override-pending-bucket (never upgrade prematurely to override-verified).
  const rawIo = createSimIo(sim, env, plan)
  const failRes = await runProductionApply({
    plan,
    env,
    io: {
      ...rawIo,
      async ensureBucket(applyCtx) {
        const out = await rawIo.ensureBucket(applyCtx)
        sim.state.faults.s3ListFail = true
        return out
      },
    },
  })
  assert.equal(failRes.ok, false)
  assert.equal(failRes.writerCredentialState, 'override-pending-bucket')
  assert.equal(failRes.bucketEmptyVerified, false)

  // Fresh missing bucket succeeds cleanly and reaches override-verified.
  const simClean = createControlledProviderSimulator({ faults: { permissionsMode: 'denied' } })
  simClean.addOperatorS3Override({
    accessKeyId: 'op-s3-pending',
    secretAccessKey: 'op-s3-pending-secret',
    allowedBuckets: ['airingcal-production'],
  })
  const cleanRes = await runProductionApply({ plan, env, io: createSimIo(simClean, env, plan) })
  assert.equal(cleanRes.ok, true, JSON.stringify(cleanRes))
  assert.equal(cleanRes.writerCredentialState, 'override-verified')
})
