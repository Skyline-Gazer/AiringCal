import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProductionPlan, mutationsExecutedFrom, runProductionApply } from './deploy-env-lib.mjs'
import { createLiveDevelopmentApplyIo } from './deploy-env-live-io.mjs'
import { DEFAULT_ACCOUNT_ID, createControlledProviderSimulator } from './fixtures/controlled-provider-sim.mjs'

test('QA-002 fail-before / pass-after: real Live I/O Adapter two-token Production Clean Init succeeds when bucket is absent', async () => {
  const sim = createControlledProviderSimulator()
  const env = {
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
  }
  const plan = buildProductionPlan({
    target: 'cloudflare',
    publicBaseUrl: '',
    mode: 'apply',
    accountId: DEFAULT_ACCOUNT_ID,
    workersDevSubdomain: 'primary-sim',
    applyAuthorized: true,
    gitSha: 'a'.repeat(40),
  })
  const io = createLiveDevelopmentApplyIo({
    env,
    plan,
    fetchImpl: sim.fetchImpl,
    spawnSyncImpl: sim.spawnSyncImpl,
    createObjectStore: sim.createObjectStore,
    sleepImpl: async () => {},
  })

  const result = await runProductionApply({ plan, env, io })
  assert.equal(result.ok, true, `expected Production clean init to succeed, got: ${JSON.stringify(result)}`)
  assert.equal(sim.hasBucket(DEFAULT_ACCOUNT_ID, 'airingcal-production'), true)
  assert.ok(mutationsExecutedFrom(result.completed, result.mutations).length > 0)
})
