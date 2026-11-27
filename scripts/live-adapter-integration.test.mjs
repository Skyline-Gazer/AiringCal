import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildProductionPlan,
  mutationsExecutedFrom,
  parseGitRemoteRepository,
  resolveTargetRepository,
  runProductionApply,
} from './deploy-env-lib.mjs'
import { createLiveDevelopmentApplyIo } from './deploy-env-live-io.mjs'
import {
  DEFAULT_ACCOUNT_ID,
  SECONDARY_ACCOUNT_ID,
  createControlledProviderSimulator,
} from './fixtures/controlled-provider-sim.mjs'
import { main as wizardMain, readInventory, resolveActiveBranch } from './setup-wizard.mjs'
import { computeVerdict } from './setup-wizard-lib.mjs'

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
    AIRINGCAL_PRODUCTION_RELEASE_SHA: '42f497cab180cd57eb1d2dc773d6b9979d9428bc',
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

// ===========================================================================
// Owner Amendments A, B, C & Section 5 Mandatory Regression & Acceptance Matrix
// ===========================================================================

function seedVerifiedExistingInstallation(sim, {
  accountId = DEFAULT_ACCOUNT_ID,
  bucket = 'airingcal-production',
  workerName = 'airingcal-production',
  boundBucket = 'airingcal-production',
  primaryUserId = '901234',
  publicBaseUrl = `https://airingcal-production.primary-sim.workers.dev`,
  releaseSha = '42f497cab180cd57eb1d2dc773d6b9979d9428bc',
  releaseRef = 'v3.0.0',
  withRelease = true,
  withS3Secrets = true,
  withScopedToken = true,
} = {}) {
  const objects = withRelease
    ? {
        'public/current-release.json': JSON.stringify({
          schema_version: 1,
          release_id: '1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          artifact_ref: 'snapshots/v1/1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
          manifest_ref: 'public/manifests/1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
          published_at: '2026-11-26T13:59:30.000Z',
        }),
        'snapshots/v1/1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json': JSON.stringify({
          schema_version: 1,
          subjects: [],
        }),
        'checkpoints/builder.sqlite': 'SQLite format 3\0checkpoint-data',
        'images/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/original': 'image-bytes',
      }
    : {}
  sim.seedBucket(accountId, bucket, { objects, r2DevEnabled: false })
  sim.seedWorker(accountId, workerName, { bucket: boundBucket })
  sim.seedGithubEnv('production', {
    variables: {
      AIRINGCAL_PRODUCTION_R2_BUCKET: bucket,
      AIRINGCAL_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: accountId,
      AIRINGCAL_PRODUCTION_PRIMARY_USER_ID: primaryUserId,
      AIRINGCAL_PRODUCTION_USERS_JSON: `[{"userId":"${primaryUserId}","username":"sim-owner"}]`,
      AIRINGCAL_PRODUCTION_PUBLIC_BASE_URL: publicBaseUrl,
      AIRINGCAL_PRODUCTION_WORKER_NAME: workerName,
      AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED: 'false',
      ...(releaseSha ? { AIRINGCAL_PRODUCTION_RELEASE_SHA: releaseSha } : {}),
      ...(releaseRef ? { AIRINGCAL_PRODUCTION_RELEASE_REF: releaseRef } : {}),
    },
    secrets: withS3Secrets
      ? [
          'AIRINGCAL_PRODUCTION_BANGUMI_TOKEN',
          'AIRINGCAL_PRODUCTION_S3_ACCESS_KEY_ID',
          'AIRINGCAL_PRODUCTION_S3_SECRET_ACCESS_KEY',
        ]
      : ['AIRINGCAL_PRODUCTION_BANGUMI_TOKEN'],
  })
  if (withScopedToken) {
    sim.seedMintedToken({
      id: 'existing-writer-tok-1',
      name: 'airingcal-production-writer',
      value: 'existing-writer-secret-1',
      policies: [
        {
          effect: 'allow',
          resources: { [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: '*' },
          permission_groups: [{ id: 'pg-r2-item-write' }],
        },
      ],
    })
  }
}

test('Section 5 #7 & Amendment A/B: Verified existing AiringCal installation update -> updates safely, preserves bucket/objects/token/secrets, qualifies runtime verification', async () => {
  const sim = createControlledProviderSimulator()
  seedVerifiedExistingInstallation(sim)
  const beforeObjects = sim.listObjects(DEFAULT_ACCOUNT_ID, 'airingcal-production')
  const beforeUnrelated = sim.snapshotUnrelatedBuckets()

  const env = makeProdEnv({ AIRINGCAL_OPERATION: 'update' })
  const plan = makeProdPlan({ operation: 'update' })
  const io = createSimIo(sim, env, plan)

  const result = await runProductionApply({ plan, env, io, operation: 'update' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.operation, 'update')
  assert.equal(result.installationState, 'verified-initialized')
  assert.equal(result.completed.includes('verify-existing-installation'), true)
  assert.equal(result.completed.includes('verify-bucket-empty'), false, 'update must never require or wipe nonempty bucket')
  assert.equal(result.completed.includes('provision-writer-credential'), false, 'update must not rotate or recreate existing writer token')
  assert.deepEqual(sim.listObjects(DEFAULT_ACCOUNT_ID, 'airingcal-production'), beforeObjects, 'all release objects, checkpoints, and images preserved')
  assert.deepEqual(sim.snapshotUnrelatedBuckets(), beforeUnrelated)
  assert.equal(sim.state.deletedTokens.length, 0, 'existing writer token never deleted')
  assert.equal(sim.state.mintedTokens.size, 1, 'no new writer token minted')

  // Amendment B: Truthful credential & isolation reporting when reusing GitHub S3 secrets without local S3 credentials
  assert.equal(result.credentialVerification.presence, 'present')
  assert.equal(result.credentialVerification.reuse, 'reused-existing')
  assert.equal(result.credentialVerification.scopeVerification, 'verified-bucket-scoped')
  assert.equal(result.credentialVerification.runtimeVerification, 'not-verified-github-secret-only')
  assert.equal(result.isolation.ok, true)
  assert.equal(result.isolation.positiveProof, null, 'must not claim positive private-object S3 proof without S3 credentials')
  assert.equal(result.isolation.anonymousDenialOnly, true)

  const verdict = computeVerdict({
    applied: result.ok,
    wantSync: false,
    operation: 'update',
    credentialRuntimeVerification: result.credentialVerification.runtimeVerification,
  })
  assert.equal(verdict.verdict, 'UPDATED_PARTIAL_VERIFICATION')
})

test('Section 5 #8, #9, #10 & Amendment A: Foreign nonempty bucket, Worker binding mismatch, or inconsistent local inventory fails closed BEFORE any mutation', async () => {
  // #8: Foreign nonempty bucket (even with Worker deployed, pointer is missing / foreign objects)
  const simForeign = createControlledProviderSimulator()
  simForeign.seedBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production', {
    objects: { 'foreign-app/db.sqlite': 'foreign-bytes' },
    r2DevEnabled: false,
  })
  simForeign.seedWorker(DEFAULT_ACCOUNT_ID, 'airingcal-production', { bucket: 'airingcal-production' })
  simForeign.seedGithubEnv('production', {
    variables: { AIRINGCAL_PRODUCTION_R2_BUCKET: 'airingcal-production' },
    secrets: ['AIRINGCAL_PRODUCTION_S3_ACCESS_KEY_ID', 'AIRINGCAL_PRODUCTION_S3_SECRET_ACCESS_KEY'],
  })
  simForeign.addOperatorS3Override({
    accessKeyId: 'op-s3-1',
    secretAccessKey: 'op-sec-1',
    allowedBuckets: ['airingcal-production'],
  })
  const envForeign = makeProdEnv({
    AIRINGCAL_OPERATION: 'update',
    AIRINGCAL_S3_ACCESS_KEY_ID: 'op-s3-1',
    AIRINGCAL_S3_SECRET_ACCESS_KEY: 'op-sec-1',
  })
  const planForeign = makeProdPlan({ operation: 'update' })
  const resForeign = await runProductionApply({
    plan: planForeign,
    env: envForeign,
    io: createSimIo(simForeign, envForeign, planForeign),
    operation: 'update',
  })
  assert.equal(resForeign.ok, false)
  assert.equal(resForeign.code, 'FOREIGN_OR_INCONSISTENT_INSTALLATION')
  assert.deepEqual(resForeign.mutationsExecuted, [], 'zero mutations on foreign bucket refusal')
  assert.deepEqual(simForeign.listObjects(DEFAULT_ACCOUNT_ID, 'airingcal-production'), ['foreign-app/db.sqlite'])

  // #9: Existing Worker bound to a different R2 bucket -> fails closed with WORKER_BINDING_MISMATCH
  const simWrongBind = createControlledProviderSimulator()
  seedVerifiedExistingInstallation(simWrongBind, { boundBucket: 'unrelated-blog-assets' })
  const envBind = makeProdEnv({ AIRINGCAL_OPERATION: 'update' })
  const planBind = makeProdPlan({ operation: 'update' })
  const resBind = await runProductionApply({
    plan: planBind,
    env: envBind,
    io: createSimIo(simWrongBind, envBind, planBind),
    operation: 'update',
  })
  assert.equal(resBind.ok, false)
  assert.equal(resBind.code, 'WORKER_BINDING_MISMATCH')
  assert.deepEqual(resBind.mutationsExecuted, [])

  // #10: Stale or mismatched local inventory (accountId or Bangumi primaryUserId or repository conflict) -> fails closed
  const simStaleInv = createControlledProviderSimulator()
  seedVerifiedExistingInstallation(simStaleInv)
  const envStale = makeProdEnv({ AIRINGCAL_OPERATION: 'update' })
  const planStale = makeProdPlan({ operation: 'update' })
  const resStaleAcct = await runProductionApply({
    plan: planStale,
    env: envStale,
    io: createSimIo(simStaleInv, envStale, planStale),
    operation: 'update',
    priorInventory: {
      schema: 'airingcal.inventory.v1',
      environment: 'production',
      repository: 'Skyline-Gazer/AiringCal',
      bucket: 'airingcal-production',
      cloudflare: { accountId: SECONDARY_ACCOUNT_ID },
    },
  })
  assert.equal(resStaleAcct.ok, false)
  assert.equal(resStaleAcct.code, 'FOREIGN_OR_INCONSISTENT_INSTALLATION')
  assert.deepEqual(resStaleAcct.mutationsExecuted, [])

  const resStaleUser = await runProductionApply({
    plan: planStale,
    env: envStale,
    io: createSimIo(simStaleInv, envStale, planStale),
    operation: 'update',
    priorInventory: {
      schema: 'airingcal.inventory.v1',
      environment: 'production',
      repository: 'Skyline-Gazer/AiringCal',
      bucket: 'airingcal-production',
      cloudflare: { accountId: DEFAULT_ACCOUNT_ID },
      bangumi: { primaryUserId: '111111' },
    },
  })
  assert.equal(resStaleUser.ok, false)
  assert.equal(resStaleUser.code, 'FOREIGN_OR_INCONSISTENT_INSTALLATION')
  assert.deepEqual(resStaleUser.mutationsExecuted, [])
})

test('Section 5 #11 & Amendment A: Insufficient or unreadable ownership evidence fails closed before any mutation', async () => {
  const sim = createControlledProviderSimulator({ faults: { workerListError: true } })
  seedVerifiedExistingInstallation(sim)
  const env = makeProdEnv({ AIRINGCAL_OPERATION: 'update' })
  const plan = makeProdPlan({ operation: 'update' })
  const res = await runProductionApply({
    plan,
    env,
    io: createSimIo(sim, env, plan),
    operation: 'update',
  })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'OWNERSHIP_EVIDENCE_INSUFFICIENT')
  assert.deepEqual(res.mutationsExecuted, [])
})

test('Section 5 #16-#20 & Amendment C: Fork-safe repository resolution (all 11 scenarios) and dynamic branch resolution', async () => {
  // 1. HTTPS GitHub remote
  assert.deepEqual(parseGitRemoteRepository('https://github.com/Alice-Fork/AiringCal.git'), {
    ok: true,
    repository: 'Alice-Fork/AiringCal',
  })
  // 2. SSH SCP GitHub remote
  assert.deepEqual(parseGitRemoteRepository('git@github.com:Bob-Fork/AiringCal.git'), {
    ok: true,
    repository: 'Bob-Fork/AiringCal',
  })
  assert.deepEqual(parseGitRemoteRepository('ssh://git@github.com/Carol-Fork/AiringCal'), {
    ok: true,
    repository: 'Carol-Fork/AiringCal',
  })
  // 3. Explicit AIRINGCAL_REPOSITORY
  assert.deepEqual(
    resolveTargetRepository({
      env: { AIRINGCAL_REPOSITORY: 'Explicit-Owner/AiringCal' },
    }),
    { repository: 'Explicit-Owner/AiringCal', source: 'AIRINGCAL_REPOSITORY' },
  )
  // 4. Trusted GITHUB_REPOSITORY context
  assert.deepEqual(
    resolveTargetRepository({
      env: { GITHUB_REPOSITORY: 'Actions-Owner/AiringCal' },
    }),
    { repository: 'Actions-Owner/AiringCal', source: 'GITHUB_REPOSITORY' },
  )
  // 5. Verified Git origin metadata
  const simFork = createControlledProviderSimulator({
    faults: { gitOriginUrl: 'git@github.com:Fork-User/AiringCal.git' },
  })
  assert.deepEqual(
    resolveTargetRepository({
      env: {},
      spawnSyncImpl: simFork.spawnSyncImpl,
      forMutation: true,
    }),
    { repository: 'Fork-User/AiringCal', source: 'git-origin' },
  )
  // 6. Conflicting AIRINGCAL_REPOSITORY vs GITHUB_REPOSITORY -> fails closed
  assert.throws(
    () =>
      resolveTargetRepository({
        env: {
          AIRINGCAL_REPOSITORY: 'Repo-A/AiringCal',
          GITHUB_REPOSITORY: 'Repo-B/AiringCal',
        },
      }),
    (err) => err.code === 'REPOSITORY_CONFLICT',
  )
  // 7. Conflicting GITHUB_REPOSITORY vs git origin -> fails closed
  assert.throws(
    () =>
      resolveTargetRepository({
        env: { GITHUB_REPOSITORY: 'Repo-B/AiringCal' },
        spawnSyncImpl: simFork.spawnSyncImpl,
      }),
    (err) => err.code === 'REPOSITORY_CONFLICT',
  )
  // 8. Missing git origin for mutation -> fails closed without falling back to Skyline-Gazer/AiringCal
  const simNoOrigin = createControlledProviderSimulator({ faults: { gitOriginMissing: true } })
  assert.throws(
    () =>
      resolveTargetRepository({
        env: {},
        spawnSyncImpl: simNoOrigin.spawnSyncImpl,
        forMutation: true,
      }),
    (err) => err.code === 'REPOSITORY_ORIGIN_MISSING',
  )
  // 9. Unsupported / non-GitHub origin -> fails closed
  const simGitlab = createControlledProviderSimulator({
    faults: { gitOriginUrl: 'https://gitlab.com/Other/AiringCal.git' },
  })
  assert.throws(
    () =>
      resolveTargetRepository({
        env: {},
        spawnSyncImpl: simGitlab.spawnSyncImpl,
        forMutation: true,
      }),
    (err) => err.code === 'REPOSITORY_ORIGIN_UNSUPPORTED',
  )
  // 10. Nonexistent or permission-denied GitHub repository -> fails closed before mutation
  const sim404 = createControlledProviderSimulator({ faults: { ghRepoNotFound: true } })
  const env404 = makeProdEnv({ AIRINGCAL_VERIFY_REPOSITORY: 'yes', AIRINGCAL_REPOSITORY: 'Ghost/AiringCal' })
  const plan404 = makeProdPlan({ repository: 'Ghost/AiringCal' })
  const res404 = await runProductionApply({
    plan: plan404,
    env: env404,
    io: createSimIo(sim404, env404, plan404),
  })
  assert.equal(res404.ok, false)
  assert.equal(res404.code, 'REPOSITORY_NOT_FOUND')
  assert.deepEqual(res404.mutationsExecuted, [])

  const simNoPerm = createControlledProviderSimulator({ faults: { ghRepoPermissionDenied: true } })
  const resNoPerm = await runProductionApply({
    plan: plan404,
    env: env404,
    io: createSimIo(simNoPerm, env404, plan404),
  })
  assert.equal(resNoPerm.ok, false)
  assert.equal(resNoPerm.code, 'REPOSITORY_PERMISSION_DENIED')
  assert.deepEqual(resNoPerm.mutationsExecuted, [])

  // 11. Fork on `main` (not `dev`) resolves branch dynamically without hardcoded `dev` failure
  const simMainBranch = createControlledProviderSimulator({
    faults: { gitCurrentBranch: 'HEAD', ghDefaultBranch: 'main' },
  })
  assert.equal(
    resolveActiveBranch({ repo: 'Fork-User/AiringCal', spawnSyncImpl: simMainBranch.spawnSyncImpl }),
    'main',
  )
})

// ===========================================================================
// Fix A1 Mandatory Regression Matrix (12 Scenarios: Explicit Production
// Release Authorization, Provenance, Update Preservation, Ref/SHA & Pre-Mutation)
// ===========================================================================

test('Fix A1 #1-#4 & #11: Fresh Production install without explicit AIRINGCAL_PRODUCTION_RELEASE_SHA fails closed before any mutation and never falls back to git HEAD, BANGUMI_GIT_COMMIT_SHA, or plan.gitSha', async () => {
  const sim = createControlledProviderSimulator({
    gitSha: '772e9323e28594c9bec43be0cc67eead5f356631', // current dev HEAD
  })
  const env = makeProdEnv({
    AIRINGCAL_PRODUCTION_RELEASE_SHA: '',
    BANGUMI_GIT_COMMIT_SHA: '772e9323e28594c9bec43be0cc67eead5f356631',
  })
  const plan = makeProdPlan({
    gitSha: '772e9323e28594c9bec43be0cc67eead5f356631',
  })
  const io = createSimIo(sim, env, plan)

  const res = await runProductionApply({ plan, env, io })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'RELEASE_IDENTITY_REQUIRED')
  assert.equal(res.errorCategory, 'resource-conflict')
  assert.deepEqual(res.mutationsExecuted, [], 'zero mutations executed when release authorization is missing')
  assert.equal(sim.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), false, 'R2 bucket must not be created')
  assert.equal(sim.state.mintedTokens.size, 0, 'Writer token must not be minted')
  assert.equal(sim.hasGithubEnv('production'), false, 'GitHub Environment must not be created')

  // Direct syncGithubEnvironment call also refuses before PUT repos/<repo>/environments/production
  await assert.rejects(
    () => io.syncGithubEnvironment({}),
    (err) => err.code === 'RELEASE_IDENTITY_REQUIRED',
  )
  assert.equal(sim.hasGithubEnv('production'), false, 'syncGithubEnvironment must not PUT environment on invalid release identity')
})

test('Fix A1 #5 & #6: Valid explicitly authorized release identity (SHA + matching REF) succeeds, while ref/SHA mismatch or mutable dev ref fails closed before mutation', async () => {
  const releasedSha = '42f497cab180cd57eb1d2dc773d6b9979d9428bc'
  const otherSha = 'e5b3c98e6b4941a398dd4a0620c2841af2960609'

  // #5: Valid matching SHA + REF
  const simValid = createControlledProviderSimulator({
    releaseTag: 'v3.0.0',
    releaseSha: releasedSha,
  })
  const envValid = makeProdEnv({
    AIRINGCAL_PRODUCTION_RELEASE_SHA: releasedSha,
    AIRINGCAL_PRODUCTION_RELEASE_REF: 'v3.0.0',
  })
  const planValid = makeProdPlan()
  const resValid = await runProductionApply({
    plan: planValid,
    env: envValid,
    io: createSimIo(simValid, envValid, planValid),
  })
  assert.equal(resValid.ok, true, JSON.stringify(resValid))
  const ghEnv = simValid.getGithubEnv('production')
  assert.equal(ghEnv.variables.AIRINGCAL_PRODUCTION_RELEASE_SHA, releasedSha)
  assert.equal(ghEnv.variables.AIRINGCAL_PRODUCTION_RELEASE_REF, 'v3.0.0')

  // #6a: Ref/SHA mismatch (v3.0.0 resolves to releasedSha, but env claims otherSha) -> fails closed before mutation
  const simMismatch = createControlledProviderSimulator({
    releaseTag: 'v3.0.0',
    releaseSha: releasedSha,
  })
  const envMismatch = makeProdEnv({
    AIRINGCAL_PRODUCTION_RELEASE_SHA: otherSha,
    AIRINGCAL_PRODUCTION_RELEASE_REF: 'v3.0.0',
  })
  const resMismatch = await runProductionApply({
    plan: planValid,
    env: envMismatch,
    io: createSimIo(simMismatch, envMismatch, planValid),
  })
  assert.equal(resMismatch.ok, false)
  assert.equal(resMismatch.code, 'RELEASE_REF_SHA_MISMATCH')
  assert.deepEqual(resMismatch.mutationsExecuted, [])
  assert.equal(simMismatch.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), false)
  assert.equal(simMismatch.state.mintedTokens.size, 0)
  assert.equal(simMismatch.hasGithubEnv('production'), false)

  // #6b: Mutable development branch ref ('dev' / 'refs/heads/dev' / 'HEAD') -> fails closed before mutation
  for (const badRef of ['dev', 'refs/heads/dev', 'HEAD']) {
    const simBadRef = createControlledProviderSimulator()
    const envBadRef = makeProdEnv({
      AIRINGCAL_PRODUCTION_RELEASE_SHA: releasedSha,
      AIRINGCAL_PRODUCTION_RELEASE_REF: badRef,
    })
    const resBadRef = await runProductionApply({
      plan: planValid,
      env: envBadRef,
      io: createSimIo(simBadRef, envBadRef, planValid),
    })
    assert.equal(resBadRef.ok, false)
    assert.equal(resBadRef.code, 'RELEASE_IDENTITY_INVALID')
    assert.deepEqual(resBadRef.mutationsExecuted, [])
    assert.equal(simBadRef.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), false)
  }
})

test('Fix A1 #7-#10: Update preserves existing release identity by default, rejects unapproved release change, and cleans up stale RELEASE_REF on authorized SHA-only upgrade', async () => {
  const existingSha = '42f497cab180cd57eb1d2dc773d6b9979d9428bc'
  const newReleaseSha = 'e5b3c98e6b4941a398dd4a0620c2841af2960609'
  const newerCheckoutHead = '772e9323e28594c9bec43be0cc67eead5f356631'

  // #7: Ordinary update from a newer checkout (where explicit AIRINGCAL_PRODUCTION_RELEASE_SHA is omitted)
  // preserves existing AIRINGCAL_PRODUCTION_RELEASE_SHA and AIRINGCAL_PRODUCTION_RELEASE_REF from remote environment!
  const simPreserve = createControlledProviderSimulator({
    gitSha: newerCheckoutHead,
  })
  seedVerifiedExistingInstallation(simPreserve, {
    releaseSha: existingSha,
    releaseRef: 'v3.0.0',
  })
  const envPreserve = makeProdEnv({
    AIRINGCAL_OPERATION: 'update',
    AIRINGCAL_PRODUCTION_RELEASE_SHA: '',
    BANGUMI_GIT_COMMIT_SHA: newerCheckoutHead,
  })
  const planPreserve = makeProdPlan({
    operation: 'update',
    gitSha: newerCheckoutHead,
  })
  const resPreserve = await runProductionApply({
    plan: planPreserve,
    env: envPreserve,
    io: createSimIo(simPreserve, envPreserve, planPreserve),
    operation: 'update',
  })
  assert.equal(resPreserve.ok, true, JSON.stringify(resPreserve))
  const ghPreserve = simPreserve.getGithubEnv('production')
  assert.equal(ghPreserve.variables.AIRINGCAL_PRODUCTION_RELEASE_SHA, existingSha, 'must preserve existing release SHA, not overwrite with checkout HEAD')
  assert.equal(ghPreserve.variables.AIRINGCAL_PRODUCTION_RELEASE_REF, 'v3.0.0', 'must preserve existing release ref')

  // #8: Unapproved release identity change during update (different SHA without AIRINGCAL_ALLOW_RELEASE_CHANGE=yes) -> fails closed before mutation
  const simUnauth = createControlledProviderSimulator({
    gitSha: newerCheckoutHead,
  })
  seedVerifiedExistingInstallation(simUnauth, {
    releaseSha: existingSha,
    releaseRef: 'v3.0.0',
  })
  const envUnauth = makeProdEnv({
    AIRINGCAL_OPERATION: 'update',
    AIRINGCAL_PRODUCTION_RELEASE_SHA: newReleaseSha,
  })
  const planUnauth = makeProdPlan({ operation: 'update' })
  const resUnauth = await runProductionApply({
    plan: planUnauth,
    env: envUnauth,
    io: createSimIo(simUnauth, envUnauth, planUnauth),
    operation: 'update',
  })
  assert.equal(resUnauth.ok, false)
  assert.equal(resUnauth.code, 'RELEASE_CHANGE_UNAUTHORIZED')
  assert.deepEqual(resUnauth.mutationsExecuted, [], 'zero mutations on unauthorized release identity change')
  assert.equal(simUnauth.getGithubEnv('production').variables.AIRINGCAL_PRODUCTION_RELEASE_SHA, existingSha)
  assert.equal(simUnauth.getGithubEnv('production').variables.AIRINGCAL_PRODUCTION_RELEASE_REF, 'v3.0.0')

  // #9 & #10: Explicitly authorized release identity change (AIRINGCAL_ALLOW_RELEASE_CHANGE=yes) with new SHA and NO ref
  // updates AIRINGCAL_PRODUCTION_RELEASE_SHA and deletes the stale AIRINGCAL_PRODUCTION_RELEASE_REF variable!
  const simUpgrade = createControlledProviderSimulator({
    gitSha: newerCheckoutHead,
  })
  seedVerifiedExistingInstallation(simUpgrade, {
    releaseSha: existingSha,
    releaseRef: 'v3.0.0',
  })
  const envUpgrade = makeProdEnv({
    AIRINGCAL_OPERATION: 'update',
    AIRINGCAL_PRODUCTION_RELEASE_SHA: newReleaseSha,
    AIRINGCAL_PRODUCTION_RELEASE_REF: '',
    AIRINGCAL_ALLOW_RELEASE_CHANGE: 'yes',
  })
  const planUpgrade = makeProdPlan({ operation: 'update' })
  const resUpgrade = await runProductionApply({
    plan: planUpgrade,
    env: envUpgrade,
    io: createSimIo(simUpgrade, envUpgrade, planUpgrade),
    operation: 'update',
  })
  assert.equal(resUpgrade.ok, true, JSON.stringify(resUpgrade))
  const ghUpgrade = simUpgrade.getGithubEnv('production')
  assert.equal(ghUpgrade.variables.AIRINGCAL_PRODUCTION_RELEASE_SHA, newReleaseSha)
  assert.equal(
    Object.prototype.hasOwnProperty.call(ghUpgrade.variables, 'AIRINGCAL_PRODUCTION_RELEASE_REF'),
    false,
    'stale AIRINGCAL_PRODUCTION_RELEASE_REF must be deleted when a new SHA is authorized without a release ref',
  )
})

test('Fix A1 #12: Development environment sync does not require or write AIRINGCAL_PRODUCTION_RELEASE_SHA', async () => {
  const { buildDevelopmentDeployPlan } = await import('./deploy-env-lib.mjs')
  const calls = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: DEFAULT_ACCOUNT_ID,
      AIRINGCAL_S3_ACCESS_KEY_ID: 'ak',
      AIRINGCAL_S3_SECRET_ACCESS_KEY: 'sk',
      AIRINGCAL_BANGUMI_TOKEN: 'bgm',
      AIRINGCAL_USERS_JSON: '[{"id":1}]',
      AIRINGCAL_PRIMARY_USER_ID: '1',
      // Deliberately no AIRINGCAL_PRODUCTION_RELEASE_SHA: Development must not require it.
    },
    plan: buildDevelopmentDeployPlan({ target: 'cloudflare', mode: 'apply' }),
    spawnSyncImpl: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      return { status: 0, stdout: '{}', stderr: '', error: null }
    },
    createObjectStore: () => ({ list: async () => [], head: async () => null, close() {} }),
  })
  await io.deriveAndVerifyS3({})
  const syncRes = await io.syncGithubEnvironment({})
  assert.equal(syncRes.environment, 'development')
  const joined = calls.join('\n')
  assert.match(joined, /variable set AIRINGCAL_DEVELOPMENT_WRITER_ENABLED/)
  assert.equal(joined.includes('RELEASE_SHA'), false, 'development sync never reads or writes release identity')
  assert.equal(joined.includes('environments/production'), false)
})
