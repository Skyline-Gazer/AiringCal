import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEVELOPMENT_DEFAULTS,
  STAGING_ALIAS_MAP,
  applyStagingAliases,
  buildCorsAllowedOrigins,
  buildDevelopmentDeployPlan,
  deriveDevelopmentConfig,
  evaluateIsolationProbe,
  parseDeployArgs,
  resolveExecutionMode,
  runDevelopmentApply,
  validateImageCdnConfig,
} from './deploy-env-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = resolve(ROOT, 'scripts', 'deploy-env.mjs')

test('parseDeployArgs defaults target to both and apply false', () => {
  assert.deepEqual(parseDeployArgs(['node', 'deploy-env.mjs']), {
    dryRun: false,
    apply: false,
    target: 'both',
    targetExplicit: false,
    forceProduction: false,
  })
  assert.deepEqual(parseDeployArgs(['node', 'deploy-env.mjs', '--dry-run', '--target', 'cloudflare']), {
    dryRun: true,
    apply: false,
    target: 'cloudflare',
    targetExplicit: true,
    forceProduction: false,
  })
  assert.deepEqual(
    parseDeployArgs(['node', 'deploy-env.mjs', '--apply', '--i-am-sure-production']),
    {
      dryRun: false,
      apply: true,
      target: 'both',
      targetExplicit: false,
      forceProduction: true,
    },
  )
})

test('resolveExecutionMode defaults production to dry-run and refuses apply without force', () => {
  assert.deepEqual(
    resolveExecutionMode({ envName: 'production', dryRun: false, apply: false, forceProduction: false }),
    { mode: 'dry-run', reason: 'production-default-dry-run' },
  )
  assert.throws(
    () =>
      resolveExecutionMode({
        envName: 'production',
        dryRun: false,
        apply: true,
        forceProduction: false,
      }),
    /production.*force|--i-am-sure-production/i,
  )
  assert.deepEqual(
    resolveExecutionMode({
      envName: 'production',
      dryRun: false,
      apply: true,
      forceProduction: true,
    }),
    { mode: 'apply', reason: 'production-forced' },
  )
  assert.deepEqual(
    resolveExecutionMode({
      envName: 'development',
      dryRun: false,
      apply: true,
      forceProduction: false,
    }),
    { mode: 'apply', reason: 'explicit-apply' },
  )
  assert.deepEqual(
    resolveExecutionMode({
      envName: 'development',
      dryRun: true,
      apply: false,
      forceProduction: false,
    }),
    { mode: 'dry-run', reason: 'explicit-dry-run' },
  )
})

test('applyStagingAliases maps STAGING_* once when new keys empty and warns', () => {
  const { env, warnings } = applyStagingAliases({
    AIRINGCAL_ENV: 'development',
    AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN: 'legacy-token',
    AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    AIRINGCAL_STAGING_BANGUMI_TOKEN: 'bgm-legacy',
    AIRINGCAL_STAGING_PRIMARY_USER_ID: '857123',
    AIRINGCAL_STAGING_PUBLIC_BASE_URL: 'https://cdn.example.test',
    AIRINGCAL_STAGING_S3_ACCESS_KEY_ID: 'AKIA_LEGACY',
    AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY: 'secret-legacy',
  })

  assert.equal(env.AIRINGCAL_CLOUDFLARE_API_TOKEN, 'legacy-token')
  assert.equal(env.AIRINGCAL_CLOUDFLARE_ACCOUNT_ID, '0123456789abcdef0123456789abcdef')
  assert.equal(env.AIRINGCAL_BANGUMI_TOKEN, 'bgm-legacy')
  assert.equal(env.AIRINGCAL_PRIMARY_USER_ID, '857123')
  assert.equal(env.AIRINGCAL_PUBLIC_BASE_URL, 'https://cdn.example.test')
  assert.equal(env.AIRINGCAL_S3_ACCESS_KEY_ID, 'AKIA_LEGACY')
  assert.equal(env.AIRINGCAL_S3_SECRET_ACCESS_KEY, 'secret-legacy')
  assert.equal(warnings.length, Object.keys(STAGING_ALIAS_MAP).length)
  assert.match(warnings[0], /deprecated/i)
  assert.match(warnings[0], /AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN/)
  assert.match(warnings[0], /AIRINGCAL_CLOUDFLARE_API_TOKEN/)
})

test('applyStagingAliases prefers new keys and skips alias when already set', () => {
  const { env, warnings } = applyStagingAliases({
    AIRINGCAL_ENV: 'development',
    AIRINGCAL_CLOUDFLARE_API_TOKEN: 'new-token',
    AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN: 'legacy-token',
    AIRINGCAL_BANGUMI_TOKEN: 'new-bgm',
    AIRINGCAL_STAGING_BANGUMI_TOKEN: 'legacy-bgm',
  })
  assert.equal(env.AIRINGCAL_CLOUDFLARE_API_TOKEN, 'new-token')
  assert.equal(env.AIRINGCAL_BANGUMI_TOKEN, 'new-bgm')
  assert.equal(warnings.length, 0)
})

test('applyStagingAliases is a no-op outside development', () => {
  const { env, warnings } = applyStagingAliases({
    AIRINGCAL_ENV: 'production',
    AIRINGCAL_STAGING_BANGUMI_TOKEN: 'legacy-bgm',
  })
  assert.equal(env.AIRINGCAL_BANGUMI_TOKEN, undefined)
  assert.equal(warnings.length, 0)
})

test('buildCorsAllowedOrigins uses exact hosts only (no port wildcards)', () => {
  const origins = buildCorsAllowedOrigins({
    cloudflareWorkerHosts: ['https://airing-cal-v3-read-staging.example.workers.dev'],
    edgeoneHosts: ['https://test.air.teijp.cn'],
  })
  assert.deepEqual(origins, [
    'https://airing-cal-v3-read-staging.example.workers.dev',
    'https://test.air.teijp.cn',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
  ])
  assert.ok(!origins.some((o) => o.includes('*')))
})

test('buildDevelopmentDeployPlan is single-bucket and aborts on isolation without dual-bucket fallback', () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    edgeoneProject: 'airingcal-edgeone-read-overseas',
    edgeoneRegion: 'overseas',
    cloudflareWorkerName: DEVELOPMENT_DEFAULTS.workerName,
    imageBaseUrl: '',
    mode: 'dry-run',
  })

  assert.equal(plan.bucket, 'airingcal-development')
  assert.equal(plan.singleBucket, true)
  assert.equal(plan.dualBucketFallback, false)
  assert.equal(plan.abortOnIsolationFailure, true)
  assert.equal(plan.writerFreeze.lever, 'workflow-disable')
  assert.notEqual(plan.writerFreeze.lever, 'AIRINGCAL_WRITER_ENABLED')
  assert.equal(plan.developmentWriterEnabled, false)

  const stepIds = plan.steps.map((s) => s.id)
  assert.ok(stepIds.includes('token-probe'))
  assert.ok(stepIds.includes('writer-freeze'))
  assert.ok(stepIds.includes('ensure-bucket'))
  assert.ok(stepIds.includes('disable-r2-dev'))
  assert.ok(stepIds.includes('isolation-probe'))
  assert.ok(stepIds.includes('copy-public'))
  assert.ok(stepIds.includes('copy-checkpoints'))
  assert.ok(stepIds.includes('sync-gh-env'))
  assert.ok(stepIds.includes('deploy-cloudflare'))
  assert.ok(stepIds.includes('deploy-edgeone'))

  const isolationIdx = stepIds.indexOf('isolation-probe')
  const copyPublicIdx = stepIds.indexOf('copy-public')
  const copyCheckpointsIdx = stepIds.indexOf('copy-checkpoints')
  assert.ok(isolationIdx < copyPublicIdx)
  assert.ok(copyPublicIdx < copyCheckpointsIdx)

  const copyCheckpoints = plan.steps.find((s) => s.id === 'copy-checkpoints')
  assert.equal(copyCheckpoints.requiresIsolationPass, true)
  assert.deepEqual(plan.keyLayout, {
    private: ['checkpoints/**'],
    public: ['public/**', 'snapshots/**', 'images/**'],
  })
})

test('evaluateIsolationProbe aborts cutover when anonymous checkpoint access is allowed', () => {
  const denied = evaluateIsolationProbe({
    r2DevDisabled: true,
    probes: [
      { url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt', method: 'GET', status: 403 },
      { url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt', method: 'HEAD', status: 404 },
    ],
  })
  assert.equal(denied.ok, true)
  assert.equal(denied.abortCutover, false)

  const leak = evaluateIsolationProbe({
    r2DevDisabled: true,
    probes: [
      { url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt', method: 'GET', status: 200 },
      { url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt', method: 'HEAD', status: 200 },
    ],
  })
  assert.equal(leak.ok, false)
  assert.equal(leak.abortCutover, true)
  assert.equal(leak.dualBucketFallback, false)
  assert.match(leak.reason, /isolation/i)

  const r2StillPublic = evaluateIsolationProbe({
    r2DevDisabled: false,
    probes: [
      { url: 'https://pub-abc.r2.dev/checkpoints/_isolation-probe.txt', method: 'GET', status: 200 },
    ],
  })
  assert.equal(r2StillPublic.ok, false)
  assert.equal(r2StillPublic.abortCutover, true)
  assert.equal(r2StillPublic.dualBucketFallback, false)
})

test('evaluateIsolationProbe aborts when probes are empty or missing GET/HEAD', () => {
  const empty = evaluateIsolationProbe({
    r2DevDisabled: true,
    probes: [],
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.abortCutover, true)
  assert.equal(empty.dualBucketFallback, false)
  assert.match(empty.reason, /empty|GET|HEAD|missing/i)

  const getOnly = evaluateIsolationProbe({
    r2DevDisabled: true,
    probes: [
      {
        url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt',
        method: 'GET',
        status: 403,
      },
    ],
  })
  assert.equal(getOnly.ok, false)
  assert.equal(getOnly.abortCutover, true)
  assert.match(getOnly.reason, /HEAD|missing/i)

  const headOnly = evaluateIsolationProbe({
    r2DevDisabled: true,
    probes: [
      {
        url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt',
        method: 'HEAD',
        status: 404,
      },
    ],
  })
  assert.equal(headOnly.ok, false)
  assert.equal(headOnly.abortCutover, true)
  assert.match(headOnly.reason, /GET|missing/i)
})

test('deriveDevelopmentConfig prefers explicit CLI --target over AIRINGCAL_DEPLOY_TARGET', () => {
  const derived = deriveDevelopmentConfig(
    {
      AIRINGCAL_ENV: 'development',
      AIRINGCAL_DEPLOY_TARGET: 'edgeone',
      AIRINGCAL_PUBLIC_BASE_URL: 'https://dev-cdn.example.test',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    { target: 'cloudflare', mode: 'dry-run' },
  )
  assert.equal(derived.plan.target, 'cloudflare')
  assert.ok(derived.plan.steps.some((s) => s.id === 'deploy-cloudflare'))
  assert.equal(
    derived.plan.steps.some((s) => s.id === 'deploy-edgeone'),
    false,
  )
})

test('CLI --target wins over AIRINGCAL_DEPLOY_TARGET env', () => {
  const result = spawnSync(process.execPath, [CLI, '--dry-run', '--target', 'cloudflare'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AIRINGCAL_ENV: 'development',
      AIRINGCAL_DEPLOY_TARGET: 'edgeone',
      AIRINGCAL_PUBLIC_BASE_URL: 'https://dev-cdn.example.test',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'test-token',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.target, 'cloudflare')
  assert.ok(plan.steps.some((s) => s.id === 'deploy-cloudflare'))
  assert.equal(
    plan.steps.some((s) => s.id === 'deploy-edgeone'),
    false,
  )
})

function createRecordingApplyIo(overrides = {}) {
  /** @type {string[]} */
  const calls = []
  const record =
    (name, impl) =>
    async (...args) => {
      calls.push(name)
      return impl(...args)
    }

  const io = {
    calls,
    probeToken: record('token-probe', async () => ({ ok: true, missingScopes: [] })),
    deriveAndVerifyS3: record('derive-s3', async () => ({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      keyIdPrinted: 'AKIA_TEST',
    })),
    freezeWriter: record('writer-freeze', async () => ({
      lever: 'workflow-disable',
      inProgress: 0,
      leaseClear: true,
    })),
    ensureBucket: record('ensure-bucket', async () => ({ bucket: DEVELOPMENT_DEFAULTS.bucket })),
    disableR2Dev: record('disable-r2-dev', async () => ({ disabled: true })),
    attachCustomDomain: record('attach-custom-domain', async () => ({ attached: true })),
    applyCacheRules: record('cache-rules', async () => ({ ok: true })),
    applyCors: record('cors', async () => ({ ok: true })),
    configureWaf: record('waf-checkpoints', async () => ({ ok: true })),
    writeIsolationProbe: record('isolation-probe-write', async () => ({
      key: DEVELOPMENT_DEFAULTS.isolationProbeKey,
      body: DEVELOPMENT_DEFAULTS.isolationProbeBody,
    })),
    probeAnonymousAccess: record('isolation-probe-check', async () => ({
      r2DevDisabled: true,
      probes: [
        {
          url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt',
          method: 'GET',
          status: 403,
        },
        {
          url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt',
          method: 'HEAD',
          status: 404,
        },
      ],
    })),
    copyPublicPrefixes: record('copy-public', async () => ({ copied: 3 })),
    copyCheckpoints: record('copy-checkpoints', async () => ({ copied: 1 })),
    syncGithubEnvironment: record('sync-gh-env', async () => ({ environment: 'development' })),
    deployCloudflareReader: record('deploy-cloudflare', async () => ({ deployed: true })),
    deployEdgeoneOverseas: record('deploy-edgeone', async () => ({ deployed: true })),
    validateImageCdn: record('image-cdn-validate', async () => ({ enabled: false })),
    runSingleWriterTest: record('single-writer-test', async () => ({ dispatched: false })),
    ...overrides,
  }

  // Re-wrap overrides so they still record when provided as plain fns.
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value !== 'function') continue
    const stepName =
      {
        probeToken: 'token-probe',
        deriveAndVerifyS3: 'derive-s3',
        freezeWriter: 'writer-freeze',
        ensureBucket: 'ensure-bucket',
        disableR2Dev: 'disable-r2-dev',
        attachCustomDomain: 'attach-custom-domain',
        applyCacheRules: 'cache-rules',
        applyCors: 'cors',
        configureWaf: 'waf-checkpoints',
        writeIsolationProbe: 'isolation-probe-write',
        probeAnonymousAccess: 'isolation-probe-check',
        copyPublicPrefixes: 'copy-public',
        copyCheckpoints: 'copy-checkpoints',
        syncGithubEnvironment: 'sync-gh-env',
        deployCloudflareReader: 'deploy-cloudflare',
        deployEdgeoneOverseas: 'deploy-edgeone',
        validateImageCdn: 'image-cdn-validate',
        runSingleWriterTest: 'single-writer-test',
      }[name] ?? name
    io[name] = record(stepName, value)
  }

  return io
}

test('runDevelopmentApply executes ordered steps with injectable I/O', async () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createRecordingApplyIo()
  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'test-token',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
    io,
  })

  assert.equal(result.ok, true)
  assert.equal(result.aborted, false)
  assert.equal(result.developmentWriterEnabled, false)
  assert.deepEqual(io.calls, [
    'token-probe',
    'derive-s3',
    'writer-freeze',
    'ensure-bucket',
    'disable-r2-dev',
    'attach-custom-domain',
    'cache-rules',
    'cors',
    'waf-checkpoints',
    'isolation-probe-write',
    'isolation-probe-check',
    'copy-public',
    'copy-checkpoints',
    'sync-gh-env',
    'deploy-cloudflare',
    'deploy-edgeone',
    'image-cdn-validate',
    'single-writer-test',
  ])
})

test('runDevelopmentApply aborts before copy when isolation fails', async () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createRecordingApplyIo({
    probeAnonymousAccess: async () => ({
      r2DevDisabled: true,
      probes: [
        {
          url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt',
          method: 'GET',
          status: 200,
        },
        {
          url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt',
          method: 'HEAD',
          status: 200,
        },
      ],
    }),
  })

  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'test-token',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
    io,
  })

  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
  assert.equal(result.abortCutover, true)
  assert.equal(result.dualBucketFallback, false)
  assert.ok(!io.calls.includes('copy-public'))
  assert.ok(!io.calls.includes('copy-checkpoints'))
  assert.ok(!io.calls.includes('sync-gh-env'))
  assert.ok(!io.calls.includes('deploy-cloudflare'))
  assert.ok(io.calls.includes('isolation-probe-check'))
  assert.equal(result.developmentWriterEnabled, false)
})
test('runDevelopmentApply derives r2DevDisabled from disableR2Dev result, not probe hardcode', async () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createRecordingApplyIo({
    disableR2Dev: async () => ({ disabled: false }),
    probeAnonymousAccess: async () => ({
      // Vacuous true must not override missing disable evidence.
      r2DevDisabled: true,
      probes: [
        {
          url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt',
          method: 'GET',
          status: 403,
        },
        {
          url: 'https://dev-cdn.example.test/checkpoints/_isolation-probe.txt',
          method: 'HEAD',
          status: 404,
        },
      ],
    }),
  })

  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'test-token',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
    io,
  })

  assert.equal(result.ok, false)
  assert.equal(result.abortCutover, true)
  assert.equal(result.dualBucketFallback, false)
  assert.ok(!io.calls.includes('copy-public'))
  assert.match(String(result.reason ?? result.isolation?.reason ?? ''), /r2\.dev|disabled/i)
})

test('createLiveDevelopmentApplyIo probeAnonymousAccess does not assume r2DevDisabled', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createLiveDevelopmentApplyIo({
    env: {},
    plan,
    fetchImpl: async () => ({ status: 403 }),
  })
  const probe = await io.probeAnonymousAccess({ plan })
  assert.equal(probe.r2DevDisabled, false)
  assert.equal(probe.probes.length, 2)
})

test('createLiveDevelopmentApplyIo marks mutating steps unsupportedLive', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createLiveDevelopmentApplyIo({ env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 't' }, plan })
  await assert.rejects(() => io.freezeWriter({}), /Owner-approved|not implemented|unsupported|credentials/i)
  await assert.rejects(() => io.writeIsolationProbe({}), /Owner-approved|not implemented|unsupported|credentials/i)
})

test('runDevelopmentApply with unsupportedLive adapters returns owner-pending not-implemented', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'token' },
    plan,
    fetchImpl: async () => ({ status: 403 }),
  })
  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'token',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
    io,
  })
  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
  assert.notEqual(result.exitCode ?? 0, 0)
  assert.match(String(result.status ?? result.reason ?? ''), /owner-gated|not-implemented|unsupported/i)
  assert.ok(Array.isArray(result.pendingOwnerSteps) || Array.isArray(result.unimplementedSteps))
  const steps = result.pendingOwnerSteps ?? result.unimplementedSteps
  assert.ok(steps.length > 0)
  assert.equal(result.dualBucketFallback, false)
})



test('validateImageCdnConfig defaults off and rejects loops / non-https / same host', () => {
  assert.deepEqual(validateImageCdnConfig({ publicBaseUrl: 'https://cdn.example.test' }), {
    enabled: false,
    imageBaseUrl: 'https://cdn.example.test',
  })
  assert.throws(
    () =>
      validateImageCdnConfig({
        publicBaseUrl: 'https://cdn.example.test',
        imageBaseUrl: 'http://images.example.test',
      }),
    /https/i,
  )
  assert.throws(
    () =>
      validateImageCdnConfig({
        publicBaseUrl: 'https://cdn.example.test',
        imageBaseUrl: 'https://cdn.example.test',
      }),
    /differ|loop|same/i,
  )
  assert.deepEqual(
    validateImageCdnConfig({
      publicBaseUrl: 'https://cdn.example.test',
      imageBaseUrl: 'https://img.example.test',
      originHost: 'cdn.example.test',
    }),
    {
      enabled: true,
      imageBaseUrl: 'https://img.example.test',
      originHost: 'cdn.example.test',
    },
  )
})

test('CLI --dry-run prints single-bucket development plan JSON', () => {
  const result = spawnSync(process.execPath, [CLI, '--dry-run', '--target', 'both'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AIRINGCAL_ENV: 'development',
      AIRINGCAL_DEPLOY_TARGET: 'both',
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'test-token',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      AIRINGCAL_BANGUMI_TOKEN: 'bgm-token',
      AIRINGCAL_PRIMARY_USER_ID: '857123',
      AIRINGCAL_PUBLIC_BASE_URL: 'https://dev-cdn.example.test',
      AIRINGCAL_EDGEONE_PROJECT: 'airingcal-edgeone-read-overseas',
      AIRINGCAL_EDGEONE_REGION: 'overseas',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.bucket, 'airingcal-development')
  assert.equal(plan.mode, 'dry-run')
  assert.equal(plan.dualBucketFallback, false)
  assert.equal(plan.abortOnIsolationFailure, true)
})

test('CLI production --apply without force exits non-zero with no mutations', () => {
  const result = spawnSync(process.execPath, [CLI, '--apply'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AIRINGCAL_ENV: 'production',
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'test-token',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      AIRINGCAL_PUBLIC_BASE_URL: 'https://prod.example.test',
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stderr}
${result.stdout}`, /production|--i-am-sure-production/i)
})
