import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { deploymentGuideLink, credentialLinks, resolveDocumentation } from './setup-docs.mjs'
import { createUi } from './setup-ui.mjs'
import { formatValidationDetails, formatValidationSummary, summarizeValidation, validateCredentials } from './setup-validate.mjs'
import { buildDevelopmentDeployPlan, buildProductionPlan } from './deploy-env-lib.mjs'
import { ENVIRONMENT_OPTIONS } from './setup-wizard.mjs'
import { buildInventory, classifyFailureRecovery, formatPlan, formatTerminalEndpointLine, sanitizeAccountName } from './setup-wizard-lib.mjs'

const ACCOUNT = 'abcdef0123456789abcdef0123456789'

function fakeFetch(routes) {
  return async (url) => {
    const u = String(url)
    const handler = routes.find(([pattern]) => pattern.test(u))
    const { status = 200, body = {} } = handler ? handler[1]() : {}
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
}

const CF_ROUTES = [
  [/\/user\/tokens\/verify$/, () => ({ body: { success: true, result: { id: 't', status: 'active' } } })],
  [/\/accounts$/, () => ({ body: { success: true, result: [{ id: ACCOUNT, name: 'Acct' }] } })],
  [/workers\/subdomain$/, () => ({ body: { success: true, result: { subdomain: 'acme' } } })],
  [/\/workers\/scripts$/, () => ({ body: { success: true, result: [] } })],
  [/\/r2\/buckets$/, () => ({ body: { success: true, result: { buckets: [] } } })],
  [/\/user\/tokens\/permissions$/, () => ({ body: { success: true, result: { permissions: ['User API Tokens:Edit'] } } })],
  [/api\.bgm\.tv\/v0\/me$/, () => ({ body: { id: 7, username: 'u' } })],
  [/users\/u\/collections/, () => ({ body: { total: 2, data: [{ subject_id: 9 }] } })],
  [/\-\/collections\/9\/episodes/, () => ({ body: { total: 1, data: [] } })],
]

test('documentation placeholders stay inert until configured and never fake a URL (#205 UX-003)', () => {
  const unset = resolveDocumentation({})
  assert.equal(unset.cloudflareSetupGuide, null)
  assert.equal(unset.deploymentGuide, null)
  const placeholders = resolveDocumentation({
    AIRINGCAL_DOC_CLOUDFLARE_SETUP_GUIDE_URL: 'https://example.com/blog/cf',
    AIRINGCAL_DOC_BANGUMI_SETUP_GUIDE_URL: '{{PLACEHOLDER}}',
    AIRINGCAL_DOC_DEPLOYMENT_GUIDE_URL: 'http://insecure.example.org/x',
  })
  assert.equal(placeholders.cloudflareSetupGuide, null, 'example.com placeholder is not rendered')
  assert.equal(placeholders.bangumiSetupGuide, null)
  assert.equal(placeholders.deploymentGuide, null, 'http URLs are rejected')
  const configured = resolveDocumentation({
    AIRINGCAL_DOC_CLOUDFLARE_SETUP_GUIDE_URL: 'https://blog.airingcal-guides.dev/cloudflare',
    AIRINGCAL_DOC_DEPLOYMENT_GUIDE_URL: 'https://blog.airingcal-guides.dev/deploy',
  })
  assert.equal(configured.cloudflareSetupGuide, 'https://blog.airingcal-guides.dev/cloudflare')
  assert.equal(configured.deploymentGuide, 'https://blog.airingcal-guides.dev/deploy')
  const links = credentialLinks('cloudflare', configured)
  assert.ok(links.some((link) => link.url === 'https://dash.cloudflare.com/profile/api-tokens'))
  assert.ok(links.some((link) => link.local === true && link.url === 'docs/DEPLOYMENT.md'))
  assert.ok(credentialLinks('bangumi', unset).some((link) => link.url === 'https://next.bgm.tv/demo/access-token'))
  assert.equal(deploymentGuideLink(unset).local, true)
})

test('credential validation separates VERIFIED / MISSING / NOT_VERIFIED / NOT_APPLICABLE (#205 UX-005)', async () => {
  const ok = await validateCredentials({
    fetchImpl: fakeFetch(CF_ROUTES),
    cloudflareToken: 'cf',
    bangumiToken: 'bgm',
  })
  assert.equal(ok.ok, true)
  const byId = (id) => ok.checks.find((entry) => entry.id === id)
  assert.equal(byId('cloudflare.token').state, 'VERIFIED')
  assert.equal(byId('bangumi.collections').state, 'VERIFIED')
  assert.equal(byId('r2.write').state, 'NOT_VERIFIED', 'write is never claimed from a read probe')
  assert.equal(byId('cloudflare.customDomain').state, 'NOT_APPLICABLE')
  assert.equal(byId('edgeone').state, 'NOT_APPLICABLE')
  assert.equal(byId('writer.provision').state, 'VERIFIED')

  const missingCf = await validateCredentials({
    fetchImpl: fakeFetch(CF_ROUTES),
    cloudflareToken: '',
    bangumiToken: 'bgm',
  })
  assert.equal(missingCf.ok, false)
  assert.ok(missingCf.blocking.includes('cloudflare.token'))

  const denied = await validateCredentials({
    fetchImpl: fakeFetch([
      [/\/user\/tokens\/verify$/, () => ({ status: 403, body: { success: false } })],
      [/api\.bgm\.tv/, () => ({ body: { id: 7, username: 'u' } })],
    ]),
    cloudflareToken: 'cf',
    bangumiToken: 'bgm',
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.checks.find((entry) => entry.id === 'cloudflare.token').state, 'MISSING')

  const invalidPat = await validateCredentials({
    fetchImpl: fakeFetch([
      [/\/user\/tokens\/verify$/, () => ({ body: { success: true, result: { id: 't', status: 'active' } } })],
      [/\/accounts$/, () => ({ body: { success: true, result: [{ id: ACCOUNT, name: 'Acct' }] } })],
      [/workers\/subdomain$/, () => ({ body: { success: true, result: { subdomain: 'acme' } } })],
      [/\/workers\/scripts$/, () => ({ body: { success: true, result: [] } })],
      [/\/r2\/buckets$/, () => ({ body: { success: true, result: {} } })],
      [/\/user\/tokens\/permissions$/, () => ({ body: { success: true, result: { permissions: [] } } })],
      [/api\.bgm\.tv/, () => ({ status: 401, body: {} })],
    ]),
    cloudflareToken: 'cf',
    bangumiToken: 'bad',
  })
  assert.equal(invalidPat.ok, false)
  assert.equal(invalidPat.checks.find((entry) => entry.id === 'bangumi.token').state, 'MISSING')
})

test('plans and summaries never claim EdgeOne for a Cloudflare-only installation (#205 UX-006)', () => {
  const prod = buildProductionPlan({ target: 'cloudflare', publicBaseUrl: '', mode: 'apply', zoneId: 'zone' })
  assert.equal(prod.edgeone, null)
  const text = formatPlan(prod)
  assert.equal(/edgeone/i.test(text), false)
  assert.equal(/airingcal-edgeone-read-production/.test(text), false)
  const both = buildProductionPlan({ target: 'both', publicBaseUrl: '', mode: 'apply', zoneId: 'zone' })
  assert.ok(both.edgeone?.project)
  const dev = buildDevelopmentDeployPlan({ target: 'cloudflare', publicBaseUrl: '' })
  assert.equal(dev.edgeone, null)
  assert.equal(dev.steps.some((step) => step.id === 'deploy-edgeone'), false)
})

test('environment options use stable labels and Production is the documented default (#205 UX-002)', () => {
  assert.deepEqual(ENVIRONMENT_OPTIONS.map((option) => option.value), ['production', 'development'])
  assert.match(ENVIRONMENT_OPTIONS[0].hint, /Standard installation/i)
  assert.match(ENVIRONMENT_OPTIONS[1].hint, /Additional environment/i)
})

class FakeTTY extends EventEmitter {
  isTTY = true
  constructor() { super() }
  setRawMode() {}
  resume() {}
  pause() {}
  write() {}
}

test('UI falls back to plain, ANSI-free output without a TTY or with NO_COLOR (#205 UX-009)', () => {
  const output = { chunks: [], write(chunk) { this.chunks.push(String(chunk)) } }
  const plain = createUi({ io: { input: { isTTY: false }, output }, env: {} })
  assert.equal(plain.interactive, false)
  plain.log.info('plain line')
  const plainText = output.chunks.join('')
  assert.equal(/\u001b\[/.test(plainText), false)
  assert.match(plainText, /plain line/)

  const ttyOut = { chunks: [], write(chunk) { this.chunks.push(String(chunk)) } }
  const noColor = createUi({ io: { input: new FakeTTY(), output: ttyOut }, env: { NO_COLOR: '1' } })
  assert.equal(noColor.color, false)
  noColor.log.success('ok text')
  assert.equal(/\u001b\[/.test(ttyOut.chunks.join('')), false)

  const dark = createUi({ io: { input: new FakeTTY(), output: ttyOut }, env: { AIRINGCAL_THEME: 'dark', TERM: 'xterm-256color' } })
  assert.equal(dark.theme, 'dark')
  assert.equal(dark.color, true)
  dark.log.error('failure text')
  const colored = ttyOut.chunks.join('')
  assert.match(colored, /\u001b\[91m/)
  assert.match(colored, /failure text/, 'status text remains readable without color')
})

test('UX-010: validation summary translates statuses into clear user-facing guidance without inflating NOT_VERIFIED', async () => {
  const res = await validateCredentials({
    fetchImpl: fakeFetch([
      ...CF_ROUTES.filter(([pattern]) => String(pattern) !== String(/\/user\/tokens\/permissions$/)),
      [/\/user\/tokens\/permissions$/, () => ({ body: { success: true, result: { permissions: [] } } })],
    ]),
    cloudflareToken: 'cf',
    bangumiToken: 'bgm',
  })
  assert.equal(res.ok, true)
  assert.equal(res.checks.find((c) => c.id === 'writer.provision').state, 'NOT_VERIFIED')
  assert.equal(res.checks.find((c) => c.id === 'r2.write').state, 'NOT_VERIFIED')

  const summary = summarizeValidation(res)
  assert.equal(summary.status, 'ready-with-notes')
  assert.ok(summary.confirmed.some((l) => /Cloudflare API Token is valid/i.test(l)))
  assert.ok(summary.confirmed.some((l) => /Bangumi PAT and anime collection access verified/i.test(l)))
  assert.ok(summary.unverified.some((l) => /Automatic Writer credential creation/i.test(l)))
  assert.match(summary.fallbackNote, /masked R2 S3 fallback/i)
  const text = formatValidationSummary(res)
  assert.match(text, /Continue to Installation/)
  const details = formatValidationDetails(res)
  assert.match(details, /NOT_VERIFIED\s+R2 object write/)
})

test('UX-013: DEPLOY_FAILED inventory separates planned vs deployed endpoints, attemptedAt vs deployedAt, and redacts emails', () => {
  const plan = buildProductionPlan({ target: 'cloudflare', publicBaseUrl: '', mode: 'apply', accountId: ACCOUNT, workersDevSubdomain: 'acme' })
  assert.equal(sanitizeAccountName("owner@example.com's Account"), "<redacted-email>'s Account")
  const inv = buildInventory({
    plan,
    account: { id: ACCOUNT, name: "owner@example.com's Account" },
    identity: { userId: '1', username: 'u' },
    environment: 'production',
    buildSha: 'a'.repeat(40),
    attemptedAt: '2026-11-26T10:36:42.311Z',
    deployedAt: null,
    writerCredentialState: 'not-provisioned',
    verdict: 'DEPLOY_FAILED',
    reason: 'aborted',
    mutationReceipts: [{ status: 'aborted', completed: ['token-probe'], mutationsExecuted: ['r2-bucket-create'], reason: 'aborted' }],
  })
  assert.equal(inv.cloudflare.accountName, "<redacted-email>'s Account")
  assert.equal(inv.publicBaseUrl, null)
  assert.equal(inv.plannedPublicBaseUrl, 'https://airingcal-production.acme.workers.dev')
  assert.equal(inv.worker.deployed, false)
  assert.equal(inv.worker.origin, null)
  assert.equal(inv.deployment.attemptedAt, '2026-11-26T10:36:42.311Z')
  assert.equal(inv.deployment.deployedAt, null)
  assert.equal(inv.writerCredentialState, 'not-provisioned')
  assert.match(
    formatTerminalEndpointLine({ verdict: 'DEPLOY_FAILED', applied: false, publicBaseUrl: inv.publicBaseUrl, plannedPublicBaseUrl: inv.plannedPublicBaseUrl }),
    /^Planned Public URL — not yet deployed or verified:/,
  )
})

test('UX-012: classifyFailureRecovery blocks blind retry on internal errors, unknown outcomes, unverified cleanups, and unproven ownership', () => {
  const internal = classifyFailureRecovery({ result: { errorCategory: 'internal-error', reason: 'bug' } })
  assert.deepEqual(internal.allowedActions, ['details', 'exit'])

  const unverifiedCleanup = classifyFailureRecovery({
    result: { errorCategory: 'scope-violation', cleanupFailed: true, mutationsSummary: { unverifiedCleanups: [{ op: 'writer-token-cleanup', target: 't1' }] } },
  })
  assert.equal(unverifiedCleanup.allowedActions.includes('retry'), false)
  assert.deepEqual(unverifiedCleanup.allowedActions, ['reconcile', 'details', 'exit'])

  const unknownOutcome = classifyFailureRecovery({
    result: { errorCategory: 'transport-failure', mutationsSummary: { unknown: [{ op: 'r2-bucket-create', target: 'airingcal-production' }] } },
  })
  assert.equal(unknownOutcome.allowedActions.includes('retry'), false)
  assert.deepEqual(unknownOutcome.allowedActions, ['reconcile', 'details', 'exit'])

  const unproven = classifyFailureRecovery({
    result: { errorCategory: 'resource-conflict', code: 'BUCKET_OWNERSHIP_UNPROVEN' },
  })
  assert.equal(unproven.allowedActions.includes('retry'), false)
  assert.ok(unproven.allowedActions.includes('reconcile'))

  const retryableTransport = classifyFailureRecovery({
    result: { errorCategory: 'transport-failure', mutationsSummary: { confirmed: [], unknown: [], unverifiedCleanups: [] } },
  })
  assert.ok(retryableTransport.allowedActions.includes('retry'))
})
