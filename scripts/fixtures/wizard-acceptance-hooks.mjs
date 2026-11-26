/**
 * #205 QA-001: deterministic provider/command adapters for the committed PTY
 * acceptance harness. Loaded ONLY when AIRINGCAL_WIZARD_TEST_HOOKS points at
 * this file; normal wizard runs never import it.
 *
 * It deliberately exercises the real orchestration (main → installFlow →
 * resolveApplyEnvironment → buildPlanForEnvironment → applyPlan →
 * runDevelopmentApply/runProductionApply → verdict) and only replaces the
 * remote provider I/O with recording doubles. Observed facts are written to
 * AIRINGCAL_WIZARD_TEST_RESULT for assertions.
 */

import { writeFileSync } from 'node:fs'

const ACCOUNT = 'f082535090d97b0927e4ed69c9a56685'
const RESULT_PATH = process.env.AIRINGCAL_WIZARD_TEST_RESULT

function record(observed, name, value) {
  observed.calls.push(name)
  return value
}

function flush(observed) {
  if (!RESULT_PATH) return
  writeFileSync(RESULT_PATH, `${JSON.stringify(observed, null, 2)}\n`, { mode: 0o600 })
}

const observed = {
  calls: [],
  applyPlans: [],
  applyEnvs: [],
  provisionAttempts: 0,
  s3OverrideSeen: false,
}

export default {
  async preflight() {},
  fetchImpl: async (url) => {
    const u = String(url)
    const json = (body) => ({ ok: true, status: 200, json: async () => body })
    if (u.endsWith('/user/tokens/verify')) return json({ success: true, result: { id: 'verified-token', status: 'active' } })
    if (u.endsWith('/accounts')) return json({ success: true, result: [{ id: ACCOUNT, name: 'Synthetic Account' }] })
    if (u.includes('/workers/subdomain')) return json({ success: true, result: { subdomain: 'r7a' } })
    if (u.includes('/zones?')) return json({ success: true, result: [] })
    if (u.endsWith('api.bgm.tv/v0/me')) return json({ id: 857123, username: 'synthetic-owner' })
    return json({ success: true, result: null })
  },
  spawnSyncImpl: (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  },
  createApplyIo: ({ env, plan }) => {
    observed.applyPlans.push({
      mode: plan.mode,
      env: plan.env,
      target: plan.target,
      bucket: plan.bucket,
      workerName: plan.cloudflareWorkerName,
      publicOriginMode: plan.publicOriginMode,
      edgeone: plan.edgeone ?? null,
      steps: plan.steps.map((step) => step.id),
    })
    observed.applyEnvs.push({
      environment: env.AIRINGCAL_ENV,
      applyAuthorized: env.AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED ?? null,
      liveConfirm: env.AIRINGCAL_DEPLOY_LIVE_CONFIRM ?? null,
      s3Override: Boolean(env.AIRINGCAL_S3_ACCESS_KEY_ID),
      workersSubdomain: env.AIRINGCAL_WORKERS_DEV_SUBDOMAIN ?? null,
    })
    let s3 = null
    const iso = { exists: true, key: 'checkpoints/_isolation-probe.txt', size: 16 }
    return {
      s3Credentials: () => s3,
      async probeToken() { return { ok: true, missingScopes: [] } },
      async deriveAndVerifyS3(ctx = {}) {
        if (plan.env === 'production') {
          if (!env.AIRINGCAL_S3_ACCESS_KEY_ID) ctx.writerCredentialDeferred = true
          const useOverride = Boolean(env.AIRINGCAL_S3_ACCESS_KEY_ID)
          if (useOverride) {
            observed.s3OverrideSeen = true
            s3 = { accessKeyId: 'override-key', secretAccessKey: 'override-secret', source: 'operator-override', scope: 'operator-supplied-scope-unverified' }
            return { ...s3, verified: true }
          }
          return { deferred: true, reason: 'production defers scoped credential' }
        }
        s3 = { accessKeyId: 'dev-key', secretAccessKey: 'dev-secret', source: 'scoped-token', scope: 'bucket-scoped' }
        return { ...s3, verified: true }
      },
      async provisionProductionWriter() {
        observed.provisionAttempts += 1
        // First attempt exercises the interactive masked fallback path.
        if (observed.provisionAttempts === 1) {
          const error = new Error('synthetic writer provisioning unavailable')
          error.missingScopes = ['User API Tokens:Edit']
          throw error
        }
        s3 = { accessKeyId: 'scoped-key', secretAccessKey: 'scoped-secret', source: 'scoped-token', scope: 'bucket-scoped', tokenName: 'airingcal-production-writer' }
        return { ...s3, verified: true }
      },
      async ensureBucket() { return record(observed, 'ensure-bucket', { bucket: plan.bucket }) },
      async disableR2Dev() { return record(observed, 'disable-r2-dev', { disabled: true }) },
      async writeIsolationProbe() { return record(observed, 'isolation-probe-write', iso) },
      async probeAnonymousAccess() {
        return record(observed, 'isolation-probe-check', {
          r2DevDisabled: true,
          probes: [
            { url: `${plan.workerOrigin}/checkpoints/_isolation-probe.txt`, method: 'GET', status: 404 },
            { url: `${plan.workerOrigin}/checkpoints/_isolation-probe.txt`, method: 'HEAD', status: 404 },
          ],
        })
      },
      async deleteIsolationProbe() { return record(observed, 'isolation-probe-cleanup', { deleted: true, key: iso.key }) },
      async syncGithubEnvironment() { return record(observed, 'sync-gh-env', { environment: plan.env }) },
      async deployCloudflareReader() { return record(observed, 'deploy-cloudflare', { deployed: true, workerUrl: plan.workerOrigin }) },
      async verifyImageRouting() { return record(observed, 'image-routing-verify', { status: 'skipped-no-release', reason: 'synthetic' }) },
      async validateImageCdn() { return record(observed, 'image-cdn-validate', { enabled: false }) },
      async freezeWriter() { return record(observed, 'writer-freeze', { lever: 'workflow-disable' }) },
      async copyPublicPrefixes() { throw new Error('copy must not run in clean init') },
      async copyCheckpoints() { throw new Error('copy must not run in clean init') },
      async attachCustomDomain() { return record(observed, 'attach-custom-domain', { attached: false }) },
      async applyCacheRules() { return record(observed, 'cache-rules', { ok: true }) },
      async applyCors() { return record(observed, 'cors', { ok: true }) },
      async configureWaf() { return record(observed, 'waf-checkpoints', { ok: true }) },
      async runSingleWriterTest() { return record(observed, 'single-writer-test', { dispatched: false }) },
    }
  },
  async syncRunner() {
    record(observed, 'first-sync', true)
    return { runId: 'synthetic-run', conclusion: 'success', cleanupVerified: true }
  },
  verifier() {
    record(observed, 'verifier', true)
    return { pass: true, failed: [], checks: [{ name: 'synthetic', pass: true }] }
  },
}

process.on('exit', () => flush(observed))
