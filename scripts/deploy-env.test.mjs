import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
    verifyImageRouting: record('image-routing-verify', async () => ({
      hash: 'a'.repeat(64),
      readers: [
        {
          base: 'https://cf-reader.example.test',
          location: `https://dev-cdn.example.test/images/${'a'.repeat(64)}/original`,
          originMatches: true,
        },
      ],
    })),
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
        verifyImageRouting: 'image-routing-verify',
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
    'image-routing-verify',
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

test('createLiveDevelopmentApplyIo probeToken fails closed on wrangler auth error', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const calls = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: (cmd, args) => {
      calls.push([cmd, ...args])
      return {
        status: 1,
        stdout: '',
        stderr: 'Unauthorized: not authenticated',
        error: null,
      }
    },
    fetchImpl: async () => ({ status: 403 }),
  })
  const result = await io.probeToken({})
  assert.equal(result.ok, false)
  assert.ok(Array.isArray(result.missingScopes))
  assert.ok(result.missingScopes.length > 0)
  assert.ok(calls.some((c) => c.includes('whoami')))
})

test('createLiveDevelopmentApplyIo deriveAndVerifyS3 uses overrides without Create Token', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const storeCalls = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      AIRINGCAL_S3_ACCESS_KEY_ID: 'AKIA_OVERRIDE',
      AIRINGCAL_S3_SECRET_ACCESS_KEY: 'secret-override',
    },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async () => {
      throw new Error('fetch should not be used for S3 override path')
    },
    createObjectStore: (config) => {
      storeCalls.push({ bucket: config.bucket, accessKeyId: config.accessKeyId })
      return {
        async list() {
          return []
        },
        async head() {
          return null
        },
        async get() {
          return null
        },
        async put() {
          return { etag: 'x' }
        },
        close() {},
      }
    },
  })
  const derived = await io.deriveAndVerifyS3({})
  assert.equal(derived.accessKeyId, 'AKIA_OVERRIDE')
  assert.equal(derived.derived, false)
  assert.equal(derived.verified, true)
  assert.equal(storeCalls[0]?.accessKeyId, 'AKIA_OVERRIDE')
})

test('createLiveDevelopmentApplyIo applyCors writes exact origins file to wrangler', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  let corsFile = null
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: (cmd, args) => {
      if (args.includes('cors') && args.includes('set')) {
        const fileIdx = args.indexOf('--file')
        corsFile = args[fileIdx + 1]
        const raw = readFileSync(corsFile, 'utf8')
        const parsed = JSON.parse(raw)
        assert.deepEqual(parsed[0].AllowedMethods, ['GET', 'HEAD'])
        assert.ok(parsed[0].AllowedOrigins.includes('http://127.0.0.1:8787'))
        assert.ok(!parsed[0].AllowedOrigins.some((o) => o.includes('*')))
      }
      return { status: 0, stdout: 'ok', stderr: '', error: null }
    },
    fetchImpl: async () => ({ status: 403 }),
  })
  const result = await io.applyCors({})
  assert.equal(result.ok, true)
  assert.ok(corsFile)
})

test('createLiveDevelopmentApplyIo freezeWriter disables workflow and waits for empty runs', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const ghCalls = []
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok' },
    plan,
    spawnSyncImpl: (cmd, args) => {
      if (cmd === 'gh') ghCalls.push(args.join(' '))
      if (args.includes('workflow') && args.includes('disable')) {
        return { status: 0, stdout: '', stderr: '', error: null }
      }
      if (args.includes('run') && args.includes('list')) {
        return { status: 0, stdout: '[]', stderr: '', error: null }
      }
      return { status: 0, stdout: '', stderr: '', error: null }
    },
    fetchImpl: async () => ({ status: 403 }),
  })
  const result = await io.freezeWriter({})
  assert.equal(result.inProgress, 0)
  assert.ok(ghCalls.some((c) => c.includes('workflow disable')))
  assert.ok(ghCalls.some((c) => c.includes('run list')))
})

test('createLiveDevelopmentApplyIo attachCustomDomain fails closed without ZONE_ID', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok' },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async () => ({ status: 403 }),
  })
  await assert.rejects(
    () => io.attachCustomDomain({}),
    /missing capability:.*AIRINGCAL_ZONE_ID/i,
  )
})

test('runDevelopmentApply with live adapters aborts before copy when isolation fails', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const copyCalls = []
  const whoamiJson = JSON.stringify({
    loggedIn: true,
    accounts: [{ id: '0123456789abcdef0123456789abcdef' }],
  })
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      AIRINGCAL_S3_ACCESS_KEY_ID: 'AKIA_TEST',
      AIRINGCAL_S3_SECRET_ACCESS_KEY: 'secret',
      AIRINGCAL_ZONE_ID: 'zone123',
      AIRINGCAL_BANGUMI_TOKEN: 'bgm',
      AIRINGCAL_PRIMARY_USER_ID: '1',
    },
    plan,
    spawnSyncImpl: (cmd, args) => {
      const joined = args.join(' ')
      if (joined.includes('whoami')) {
        return { status: 0, stdout: whoamiJson, stderr: '', error: null }
      }
      if (joined.includes('dev-url get')) {
        return {
          status: 0,
          stdout: 'Public access via the r2.dev URL is disabled for this bucket.',
          stderr: '',
          error: null,
        }
      }
      return { status: 0, stdout: '[]', stderr: '', error: null }
    },
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/rulesets')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              result: { id: 'ruleset-1', rules: [] },
            }
          },
        }
      }
      // Isolation anonymous probes intentionally return 200 → abort before copy.
      if (u.includes('checkpoints/_isolation-probe')) {
        return { status: 200, ok: true, async json() { return {} } }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, result: {} }
        },
      }
    },
    createObjectStore: () => ({
      async list() {
        return []
      },
      async head() {
        return null
      },
      async get() {
        return null
      },
      async put(key) {
        return { etag: 'p', key }
      },
      close() {},
    }),
  })
  const origCopyPublic = io.copyPublicPrefixes.bind(io)
  const origCopyCheckpoints = io.copyCheckpoints.bind(io)
  io.copyPublicPrefixes = async (...args) => {
    copyCalls.push('copy-public')
    return origCopyPublic(...args)
  }
  io.copyCheckpoints = async (...args) => {
    copyCalls.push('copy-checkpoints')
    return origCopyCheckpoints(...args)
  }

  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
    io,
  })
  assert.equal(result.ok, false)
  assert.equal(result.abortCutover, true)
  assert.equal(result.dualBucketFallback, false)
  assert.deepEqual(copyCalls, [])
  assert.ok(result.completed.includes('isolation-probe-check'))
  assert.ok(!result.completed.includes('copy-public'))
})

test('runDevelopmentApply happy path invokes ordered live adapters via doubles', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const liveImageHash = 'b'.repeat(64)
  const spawnLog = []
  const materializeEnvs = []
  let ghRunListCount = 0
  const whoamiJson = JSON.stringify({
    loggedIn: true,
    accounts: [{ id: '0123456789abcdef0123456789abcdef' }],
  })
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      AIRINGCAL_S3_ACCESS_KEY_ID: 'AKIA_TEST',
      AIRINGCAL_S3_SECRET_ACCESS_KEY: 'secret',
      AIRINGCAL_ZONE_ID: 'zone123',
      AIRINGCAL_BANGUMI_TOKEN: 'bgm',
      AIRINGCAL_PRIMARY_USER_ID: '1',
      AIRINGCAL_EDGEONE_API_TOKEN: 'eo-tok',
      AIRINGCAL_EDGEONE_READER_URL: 'https://eo-reader.example.test',
      AIRINGCAL_IMAGE_BASE_URL: 'https://img.example.test',
      AIRINGCAL_DEPLOY_WRITER_TEST: 'yes',
    },
    plan,
    spawnSyncImpl: (cmd, args, opts) => {
      spawnLog.push([cmd, args.join(' ')])
      const joined = args.join(' ')
      if (joined.includes('whoami')) {
        return { status: 0, stdout: whoamiJson, stderr: '', error: null }
      }
      if (joined.includes('dev-url get')) {
        return {
          status: 0,
          stdout: 'Public access via the r2.dev URL is disabled for this bucket.',
          stderr: '',
          error: null,
        }
      }
      if (joined.includes('materialize-v3-read-staging-config')) {
        materializeEnvs.push({ ...(opts?.env ?? {}) })
        return { status: 0, stdout: '', stderr: 'wrote', error: null }
      }
      if (cmd === 'pnpm' && joined.includes('build:edgeone-read')) {
        return { status: 0, stdout: '', stderr: '', error: null }
      }
      if (cmd === 'edgeone') {
        return { status: 0, stdout: 'deployed', stderr: '', error: null }
      }
      if (joined.includes('deploy') && joined.includes('--config')) {
        return {
          status: 0,
          stdout: 'Published https://airing-cal-v3-read-staging.r7a.workers.dev',
          stderr: '',
          error: null,
        }
      }
      if (joined.includes('secret list')) {
        return { status: 0, stdout: '', stderr: '', error: null }
      }
      if (joined.includes('--status in_progress')) {
        return { status: 0, stdout: '[]', stderr: '', error: null }
      }
      if (joined.includes('run list')) {
        ghRunListCount += 1
        const runs =
          ghRunListCount === 1
            ? [{ databaseId: 100, createdAt: '2026-11-06T00:00:00Z', status: 'completed' }]
            : [{ databaseId: 101, createdAt: '2026-11-07T00:00:00Z', status: 'completed' }]
        return { status: 0, stdout: JSON.stringify(runs), stderr: '', error: null }
      }
      if (joined.includes('run view')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            status: 'completed',
            conclusion: 'success',
            jobs: [{ name: 'development', conclusion: 'success' }],
          }),
          stderr: '',
          error: null,
        }
      }
      return { status: 0, stdout: 'ok', stderr: '', error: null }
    },
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/rulesets/phases/')) {
        return {
          ok: false,
          status: 404,
          async json() {
            return { success: false, errors: [{ code: 10000, message: 'not found' }] }
          },
        }
      }
      if (u.includes('/rulesets')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: { id: 'new-ruleset' } }
          },
        }
      }
      if (u.includes('checkpoints/_isolation-probe')) {
        return { status: 403, ok: false, async json() { return {} } }
      }
      if (u.endsWith('/public/current-release.json')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { artifact_ref: 'snapshots/v1/7-abc.json' }
          },
        }
      }
      if (u.includes('/snapshots/v1/')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              collections: { watching: [{ images: { large: { hash: liveImageHash } } }] },
              calendar: [],
            }
          },
        }
      }
      if (u.includes('/image/')) {
        return {
          ok: false,
          status: 302,
          headers: {
            get: (name) =>
              String(name).toLowerCase() === 'location'
                ? `https://img.example.test/images/${liveImageHash}/original`
                : null,
          },
          async json() {
            return {}
          },
        }
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { success: true, result: {} }
        },
      }
    },
    createObjectStore: (config) => ({
      async list(prefix) {
        if (config.bucket.includes('staging-public') && prefix === 'public/') {
          return ['public/current-release.json']
        }
        if (config.bucket.includes('staging-checkpoint') && prefix === 'checkpoints/') {
          return ['checkpoints/lease.json']
        }
        return []
      },
      async head(key) {
        if (key === 'public/current-release.json' || key === 'checkpoints/lease.json') {
          return { etag: 'etag1', size: 4, contentType: 'application/json' }
        }
        return null
      },
      async get(key) {
        return {
          body: new TextEncoder().encode('data'),
          etag: 'etag1',
          contentType: 'application/json',
        }
      },
      async put() {
        return { etag: 'etag2' }
      },
      close() {},
    }),
    sleepImpl: async () => {},
  })

  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
      AIRINGCAL_DEPLOY_WRITER_TEST: 'yes',
    },
    io,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.dualBucketFallback, false)
  assert.ok(result.completed.includes('copy-public'))
  assert.ok(result.completed.includes('copy-checkpoints'))
  assert.ok(result.completed.includes('deploy-cloudflare'))
  assert.ok(result.completed.includes('deploy-edgeone'))
  assert.ok(result.completed.includes('image-routing-verify'))
  assert.ok(
    result.completed.indexOf('image-routing-verify') > result.completed.indexOf('deploy-edgeone'),
    'routing verify must run after deploys',
  )
  assert.ok(
    result.completed.indexOf('image-routing-verify') <
      result.completed.indexOf('image-cdn-validate'),
    'routing verify must run before validateImageCdn',
  )
  assert.equal(result.imageRouting?.hash, liveImageHash)
  assert.deepEqual(
    (result.imageRouting?.readers ?? []).map((r) => r.base).sort(),
    ['https://airing-cal-v3-read-staging.r7a.workers.dev', 'https://eo-reader.example.test'],
  )
  assert.ok(result.imageRouting.readers.every((r) => r.originMatches === true))
  // Gap A: the materialize child env receives AIRINGCAL_IMAGE_BASE_URL explicitly.
  assert.ok(materializeEnvs.length > 0, 'materialize must run')
  assert.equal(materializeEnvs[0].AIRINGCAL_IMAGE_BASE_URL, 'https://img.example.test')
  // Gap B: EdgeOne env pairs include the image base when configured.
  assert.ok(
    spawnLog.some(
      ([cmd, args]) =>
        cmd === 'edgeone' &&
        args.includes('env set AIRINGCAL_IMAGE_BASE_URL https://img.example.test'),
    ),
    `edgeone env set missing image base: ${spawnLog.map(([c, a]) => `${c} ${a}`).join(' | ')}`,
  )
  assert.ok(spawnLog.some(([cmd, args]) => cmd === 'gh' && args.includes('workflow disable')))
  assert.ok(spawnLog.some(([cmd, args]) => cmd === 'pnpm' && args.includes('cors set')))
  assert.ok(spawnLog.some(([cmd]) => cmd === 'edgeone'))
  const ghJoined = spawnLog.filter(([cmd]) => cmd === 'gh').map(([, args]) => args)
  assert.ok(ghJoined.some((a) => a.includes('workflow enable')))
  assert.ok(
    ghJoined.some(
      (a) => a.includes('variable set AIRINGCAL_DEVELOPMENT_WRITER_ENABLED') && a.includes('--body true') && !a.includes('--env'),
    ),
    `repo-level gate var not set true: ${ghJoined.join(' | ')}`,
  )
  assert.ok(
    ghJoined.some((a) => a.includes('workflow run portable-writer.yml') && a.includes('target=development')),
  )
  assert.ok(ghJoined.some((a) => a.includes('run view 101')))
  assert.ok(
    ghJoined.some(
      (a) => a.includes('variable set AIRINGCAL_DEVELOPMENT_WRITER_ENABLED') && a.includes('--body false'),
    ),
  )
  assert.equal(result.singleWriterTest?.runId, 101)
  assert.equal(result.singleWriterTest?.jobConclusion, 'success')
  assert.ok(result.completed.includes('single-writer-test'))
})

function writerTestSpawnDouble({ jobs, conclusion = 'success', status = 'completed' }) {
  const ghCalls = []
  let listCount = 0
  const spawnSyncImpl = (cmd, args) => {
    const joined = args.join(' ')
    if (cmd === 'gh') ghCalls.push(joined)
    if (joined.includes('run list')) {
      listCount += 1
      const runs =
        listCount === 1
          ? [{ databaseId: 100, createdAt: '2026-11-06T00:00:00Z', status: 'completed' }]
          : [{ databaseId: 101, createdAt: '2026-11-07T00:00:00Z', status: 'completed' }]
      return { status: 0, stdout: JSON.stringify(runs), stderr: '', error: null }
    }
    if (joined.includes('run view')) {
      return {
        status: 0,
        stdout: JSON.stringify({ status, conclusion, jobs }),
        stderr: '',
        error: null,
      }
    }
    return { status: 0, stdout: 'ok', stderr: '', error: null }
  }
  return { ghCalls, spawnSyncImpl }
}

function buildWriterTestIo(spawnSyncImpl, extraEnv = {}) {
  return import('./deploy-env.mjs').then(({ createLiveDevelopmentApplyIo }) => {
    const plan = buildDevelopmentDeployPlan({
      target: 'cloudflare',
      publicBaseUrl: 'https://dev-cdn.example.test',
      mode: 'apply',
    })
    return createLiveDevelopmentApplyIo({
      env: {
        AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
        AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        AIRINGCAL_DEPLOY_WRITER_TEST: 'yes',
        ...extraEnv,
      },
      plan,
      spawnSyncImpl,
      fetchImpl: async () => {
        throw new Error('fetch must not be used by runSingleWriterTest')
      },
      sleepImpl: async () => {},
    })
  })
}

test('runSingleWriterTest success: enable → repo var true → run → poll → repo var false → disable, receipt returned', async () => {
  const { ghCalls, spawnSyncImpl } = writerTestSpawnDouble({
    jobs: [{ name: 'development', conclusion: 'success' }],
  })
  const io = await buildWriterTestIo(spawnSyncImpl)
  const receipt = await io.runSingleWriterTest({})
  assert.equal(receipt.dispatched, true)
  assert.equal(receipt.runId, 101)
  assert.equal(receipt.conclusion, 'success')
  assert.equal(receipt.jobConclusion, 'success')
  assert.equal(receipt.restored, true)
  assert.equal(
    receipt.url,
    'https://github.com/Skyline-Gazer/AiringCal/actions/runs/101',
  )
  const order = ghCalls.map((c) => {
    if (c.includes('workflow enable')) return 'enable'
    if (c.includes('--body true')) return 'var-true'
    if (c.includes('workflow run')) return 'run'
    if (c.includes('run list')) return 'list'
    if (c.includes('run view')) return 'view'
    if (c.includes('--body false')) return 'var-false'
    if (c.includes('workflow disable')) return 'disable'
    return 'other'
  })
  assert.deepEqual(order, ['enable', 'var-true', 'list', 'run', 'list', 'view', 'var-false', 'disable'])
  assert.ok(ghCalls.every((c) => c.includes('Skyline-Gazer/AiringCal')))
})

test('runSingleWriterTest fails closed on skipped development job (skipped ≠ pass) and restores freeze', async () => {
  const { ghCalls, spawnSyncImpl } = writerTestSpawnDouble({
    jobs: [
      { name: 'staging', conclusion: 'skipped' },
      { name: 'development', conclusion: 'skipped' },
    ],
  })
  const io = await buildWriterTestIo(spawnSyncImpl)
  await assert.rejects(
    () => io.runSingleWriterTest({}),
    /single-writer test skipped \(writer gate not visible\) — not a pass/,
  )
  assert.ok(ghCalls.some((c) => c.includes('--body false')))
  assert.ok(ghCalls.some((c) => c.includes('workflow disable')))
})

test('runSingleWriterTest fails with run URL on failed development job, freeze restored', async () => {
  const { ghCalls, spawnSyncImpl } = writerTestSpawnDouble({
    jobs: [{ name: 'development', conclusion: 'failure' }],
    conclusion: 'failure',
  })
  const io = await buildWriterTestIo(spawnSyncImpl)
  await assert.rejects(() => io.runSingleWriterTest({}), /actions\/runs\/101/)
  assert.ok(ghCalls.some((c) => c.includes('workflow disable')))
})

test('runSingleWriterTest refuses when ctx.developmentWriterEnabled is true', async () => {
  const { ghCalls, spawnSyncImpl } = writerTestSpawnDouble({
    jobs: [{ name: 'development', conclusion: 'success' }],
  })
  const io = await buildWriterTestIo(spawnSyncImpl)
  await assert.rejects(
    () => io.runSingleWriterTest({ developmentWriterEnabled: true }),
    /developmentWriterEnabled=true/,
  )
  assert.equal(ghCalls.length, 0)
})

test('runSingleWriterTest non-opt-in returns skipped receipt without gh calls', async () => {
  const { ghCalls, spawnSyncImpl } = writerTestSpawnDouble({
    jobs: [{ name: 'development', conclusion: 'success' }],
  })
  const io = await buildWriterTestIo(spawnSyncImpl, { AIRINGCAL_DEPLOY_WRITER_TEST: '' })
  const receipt = await io.runSingleWriterTest({})
  assert.equal(receipt.dispatched, false)
  assert.equal(receipt.skipped, true)
  assert.match(receipt.reason, /AIRINGCAL_DEPLOY_WRITER_TEST=yes/)
  assert.equal(ghCalls.length, 0)
})

test('runDevelopmentApply keeps skipped single-writer test out of completed and marks it pending', async () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createRecordingApplyIo()
  const result = await runDevelopmentApply({
    plan,
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes' },
    io,
  })
  assert.equal(result.ok, true)
  assert.ok(!result.completed.includes('single-writer-test'))
  assert.equal(result.singleWriterTest.status, 'pending-not-opt-in')
  assert.ok((result.pendingOwnerSteps ?? []).some((s) => s.includes('single-writer-test')))
})

test('runDevelopmentApply records dispatched single-writer test as completed', async () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createRecordingApplyIo({
    runSingleWriterTest: async () => ({
      dispatched: true,
      runId: 4242,
      conclusion: 'success',
      jobConclusion: 'success',
      restored: true,
    }),
  })
  const result = await runDevelopmentApply({
    plan,
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes' },
    io,
  })
  assert.equal(result.ok, true)
  assert.ok(result.completed.includes('single-writer-test'))
  assert.equal(result.singleWriterTest.runId, 4242)
  assert.ok(
    !(result.pendingOwnerSteps ?? []).some((s) => String(s).includes('single-writer-test')),
  )
})

test('buildDevelopmentDeployPlan CORS methods are GET/HEAD only (no OPTIONS)', () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'dry-run',
  })
  assert.deepEqual(plan.cors.methods, ['GET', 'HEAD'])
  const corsStep = plan.steps.find((s) => s.id === 'cors')
  assert.deepEqual(corsStep.methods, ['GET', 'HEAD'])
})

test('applyCors throws on OPTIONS in caller-supplied methods without touching wrangler', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = {
    ...buildDevelopmentDeployPlan({
      target: 'both',
      publicBaseUrl: 'https://dev-cdn.example.test',
      mode: 'apply',
    }),
    cors: { allowedOrigins: ['https://dev-cdn.example.test'], methods: ['GET', 'HEAD', 'OPTIONS'] },
  }
  const spawnCalls = []
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok' },
    plan,
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push([cmd, args.join(' ')])
      return { status: 0, stdout: '', stderr: '', error: null }
    },
    fetchImpl: async () => ({ status: 403 }),
  })
  await assert.rejects(() => io.applyCors({}), /OPTIONS/)
  assert.equal(spawnCalls.length, 0)
})

test('applyCacheRules + configureWaf scope every expression to plan.publicHost via http.host', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const rulePosts = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('/rulesets/phases/')) {
      return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
    }
    if (u.includes('/rulesets') && String(init.method ?? 'GET') === 'POST') {
      rulePosts.push(JSON.parse(init.body))
      return {
        ok: true,
        status: 200,
        async json() { return { success: true, result: { id: 'ruleset-new', rules: [] } } },
      }
    }
    return { ok: true, status: 200, async json() { return { success: true, result: {} } } }
  }
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_ZONE_ID: 'zone123',
    },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl,
  })

  await io.applyCacheRules({})
  await io.configureWaf({})

  assert.equal(rulePosts.length, 3)
  const immutable = rulePosts.find((p) =>
    p.rules[0].description.includes('immutable'),
  )
  const pointer = rulePosts.find((p) => p.rules[0].description.includes('pointer'))
  const waf = rulePosts.find((p) => p.rules[0].description.includes('deny-checkpoints'))
  assert.ok(waf, 'WAF ruleset POST missing')
  assert.equal(
    immutable.rules[0].expression,
    '(http.host eq "dev-cdn.example.test" and (starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/snapshots/")))',
  )
  assert.equal(
    pointer.rules[0].expression,
    '(http.host eq "dev-cdn.example.test" and http.request.uri.path eq "/public/current-release.json")',
  )
  assert.equal(
    waf.rules[0].expression,
    '(http.host eq "dev-cdn.example.test" and starts_with(http.request.uri.path, "/checkpoints/"))',
  )
})

test('applyCacheRules + configureWaf refuse when plan.publicHost is missing', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = {
    ...buildDevelopmentDeployPlan({
      target: 'both',
      publicBaseUrl: 'https://dev-cdn.example.test',
      mode: 'apply',
    }),
    publicHost: '',
  }
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_ZONE_ID: 'zone123' },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { success: true, result: {} } } }),
  })
  await assert.rejects(() => io.applyCacheRules({}), /plan\.publicHost/)
  await assert.rejects(() => io.configureWaf({}), /plan\.publicHost/)
})

const VERIFY_TOKEN_ID = 'ed17574386854bf78a67040be0a770b0'

test('deriveAndVerifyS3 derives S3 creds from the management token without creating any token', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const parentToken = 'cf-mgmt-token-value-1234567890abcdef'
  const expectedSecret = createHash('sha256').update(parentToken, 'utf8').digest('hex')
  const fetchLog = []
  const storeConfigs = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: parentToken,
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: () => {
      throw new Error('gh/wrangler must not run on the management-token derivation path')
    },
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      fetchLog.push([String(init.method ?? 'GET'), u])
      if (u.endsWith('/user/tokens/verify')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: { id: VERIFY_TOKEN_ID, status: 'active' } }
          },
        }
      }
      return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: (config) => {
      storeConfigs.push({
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        endpoint: config.endpoint,
      })
      return {
        async list() { return [] },
        async head() { return null },
        close() {},
      }
    },
  })
  let printed = ''
  const origWrite = process.stderr.write
  process.stderr.write = (chunk) => { printed += String(chunk); return true }
  let result
  try {
    result = await io.deriveAndVerifyS3({})
  } finally {
    process.stderr.write = origWrite
  }
  assert.equal(result.derived, true)
  assert.equal(result.source, 'management-token')
  assert.equal(result.verified, true)
  assert.equal(result.accessKeyId, VERIFY_TOKEN_ID)
  assert.equal(result.keyIdPrinted, VERIFY_TOKEN_ID)
  assert.equal(storeConfigs[0].accessKeyId, VERIFY_TOKEN_ID)
  assert.equal(storeConfigs[0].secretAccessKey, expectedSecret)
  assert.equal(storeConfigs[0].endpoint, 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com')
  assert.ok(!fetchLog.some(([m, u]) => m === 'POST' && u.endsWith('/user/tokens')), 'must not create tokens')
  assert.ok(fetchLog.some(([m, u]) => m === 'GET' && u.endsWith('/user/tokens/verify')))
  assert.ok(!printed.includes(expectedSecret), 'SHA-256 secret must never be printed')
  assert.ok(!printed.includes(parentToken), 'parent token value must never be printed')
  assert.ok(printed.includes(VERIFY_TOKEN_ID), 'key id is printed')
  // The creds land in ctx.s3 with the secret for the later GH Environment sync.
  assert.equal(result.secretAccessKey, expectedSecret)
})

test('deriveAndVerifyS3 continues to scoped-token fallback when parent token cannot verify', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      const method = String(init.method ?? 'GET')
      if (u.endsWith('/user/tokens/verify')) {
        return { ok: false, status: 403, async json() { return { success: false, errors: [{ code: 10000, message: 'Unauthorized' }] } } }
      }
      if (u.endsWith('/user/tokens/permissions')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: { status: 'active', permissions: [{ id: 'p1', name: 'User API Tokens: Edit' }] } }
          },
        }
      }
      if (u.endsWith('/user/tokens') && method === 'GET') {
        return { ok: true, status: 200, async json() { return { success: true, result: [] } } }
      }
      if (u.endsWith('/user/tokens/permission_groups')) {
        return { ok: true, status: 200, async json() { return { success: true, result: [] } } }
      }
      if (u.endsWith('/user/tokens') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          async json() { return { success: true, result: { id: 'AKIANEW', value: 'fresh-token-value' } } },
        }
      }
      return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: () => ({
      async list() { return [] },
      async head() { return null },
      close() {},
    }),
  })
  const result = await io.deriveAndVerifyS3({})
  assert.equal(result.derived, true)
  assert.equal(result.source, undefined)
  assert.equal(result.accessKeyId, 'AKIANEW')
})

test('deriveAndVerifyS3 falls through to scoped-token creation when management S3 access is denied', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const fetchLog = []
  const storeKeys = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      const method = String(init.method ?? 'GET')
      fetchLog.push([method, u])
      if (u.endsWith('/user/tokens/verify')) {
        return {
          ok: true,
          status: 200,
          async json() { return { success: true, result: { id: VERIFY_TOKEN_ID, status: 'active' } } },
        }
      }
      if (u.endsWith('/user/tokens/permissions')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: { status: 'active', permissions: ['User API Tokens:Edit'] } }
          },
        }
      }
      if (u.endsWith('/user/tokens') && method === 'GET') {
        return { ok: true, status: 200, async json() { return { success: true, result: [] } } }
      }
      if (u.endsWith('/user/tokens/permission_groups')) {
        return { ok: true, status: 200, async json() { return { success: true, result: [] } } }
      }
      if (u.endsWith('/user/tokens') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          async json() { return { success: true, result: { id: 'AKIANEW', value: 'fresh-token-value' } } },
        }
      }
      return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: (config) => ({
      async list() {
        storeKeys.push(config.accessKeyId)
        if (config.accessKeyId === VERIFY_TOKEN_ID) {
          const err = new Error('AccessDenied: management token lacks R2 object access')
          err.$metadata = { httpStatusCode: 403 }
          throw err
        }
        return []
      },
      async head() { return null },
      close() {},
    }),
  })
  const result = await io.deriveAndVerifyS3({})
  assert.equal(result.derived, true)
  assert.equal(result.accessKeyId, 'AKIANEW')
  assert.ok(storeKeys.includes(VERIFY_TOKEN_ID), 'management creds must be tried first')
  const createCall = fetchLog.find(([m, u]) => m === 'POST' && u.endsWith('/user/tokens'))
  assert.ok(createCall, 'scoped-token creation must run after management S3 denial')
})

test('deriveAndVerifyS3 falls through to scoped-token creation when verify omits result.id', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const storeKeys = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      const method = String(init.method ?? 'GET')
      if (u.endsWith('/user/tokens/verify')) {
        // Docs mark `result` optional; a shape without id is a management-path failure.
        return { ok: true, status: 200, async json() { return { success: true, result: { status: 'active' } } } }
      }
      if (u.endsWith('/user/tokens/permissions')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: { status: 'active', permissions: ['User API Tokens:Edit'] } }
          },
        }
      }
      if (u.endsWith('/user/tokens') && method === 'GET') {
        return { ok: true, status: 200, async json() { return { success: true, result: [] } } }
      }
      if (u.endsWith('/user/tokens/permission_groups')) {
        return { ok: true, status: 200, async json() { return { success: true, result: [] } } }
      }
      if (u.endsWith('/user/tokens') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          async json() { return { success: true, result: { id: 'AKIANEW', value: 'fresh-token-value' } } },
        }
      }
      return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: (config) => ({
      async list() { storeKeys.push(config.accessKeyId); return [] },
      async head() { return null },
      close() {},
    }),
  })
  const result = await io.deriveAndVerifyS3({})
  assert.equal(result.accessKeyId, 'AKIANEW')
  assert.ok(!storeKeys.includes(VERIFY_TOKEN_ID))
  assert.equal(storeKeys.length, 1, 'only the fallback creds may touch the store')
})

test('scoped-token fallback deletes the prior stable-named token before POST', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const fetchLog = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      const method = String(init.method ?? 'GET')
      fetchLog.push([method, u])
      if (u.endsWith('/user/tokens/verify')) {
        return { ok: false, status: 403, async json() { return { success: false, errors: [] } } }
      }
      if (u.endsWith('/user/tokens/permissions')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: { status: 'active', permissions: ['User API Tokens:Edit'] } }
          },
        }
      }
      if (u.endsWith('/user/tokens') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              result: [
                { id: 'old-token-1', name: 'airingcal-development-s3' },
                { id: 'unrelated-token', name: 'someone-else' },
              ],
            }
          },
        }
      }
      if (/\/user\/tokens\/[^/]+$/.test(u) && method === 'DELETE') {
        return { ok: true, status: 200, async json() { return { success: true, result: { id: 'old-token-1' } } } }
      }
      if (u.endsWith('/user/tokens/permission_groups')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: [{ id: 'grp-r2w', name: 'Workers R2 Storage Write' }] }
          },
        }
      }
      if (u.endsWith('/user/tokens') && method === 'POST') {
        return {
          ok: true,
          status: 200,
          async json() { return { success: true, result: { id: 'AKIANEW', value: 'fresh-token-value' } } },
        }
      }
      return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: () => ({
      async list() { return [] },
      async head() { return null },
      close() {},
    }),
  })
  const result = await io.deriveAndVerifyS3({})
  assert.equal(result.accessKeyId, 'AKIANEW')
  const deleteIdx = fetchLog.findIndex(([m, u]) => m === 'DELETE' && u.endsWith('/user/tokens/old-token-1'))
  const createIdx = fetchLog.findIndex(([m, u]) => m === 'POST' && u.endsWith('/user/tokens'))
  assert.ok(deleteIdx >= 0, 'prior stable-named token must be deleted')
  assert.ok(createIdx >= 0)
  assert.ok(deleteIdx < createIdx, 'delete must precede create')
  assert.ok(!fetchLog.some(([m, u]) => m === 'DELETE' && u.includes('unrelated-token')), 'never delete other tokens')
})

test('deriveAndVerifyS3 probes token-creation permission and exits-2 style on denial without creating', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const fetchLog = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'secret not found', error: null }),
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      const method = String(init.method ?? 'GET')
      fetchLog.push([method, u])
      if (u.endsWith('/user/tokens/permissions')) {
        return {
          ok: false,
          status: 403,
          async json() {
            return { success: false, errors: [{ code: 10000, message: 'Unauthorized to create tokens' }] }
          },
        }
      }
      return { ok: false, status: 403, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: () => {
      throw new Error('object store must not be built when permission probe denies')
    },
  })
  await assert.rejects(
    () => io.deriveAndVerifyS3({}),
    (error) => {
      assert.deepEqual(error.missingScopes, [
        'User API Tokens: Edit (Create tokens via API)',
        'override workaround: set AIRINGCAL_S3_ACCESS_KEY_ID / AIRINGCAL_S3_SECRET_ACCESS_KEY in .env',
      ])
      assert.match(error.message, /User API Tokens: Edit/)
      return true
    },
  )
  assert.ok(fetchLog.some(([m, u]) => m === 'GET' && u.endsWith('/user/tokens/permissions')))
  assert.ok(!fetchLog.some(([m, u]) => m === 'POST' && u.endsWith('/user/tokens')))
})

test('deriveAndVerifyS3 creates stable-named token only after permission probe passes', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  let createBody = null
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    },
    plan,
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'gh: secret not found', error: null }),
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      const method = String(init.method ?? 'GET')
      if (u.endsWith('/user/tokens/permissions')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: { status: 'active', permissions: ['User API Tokens:Edit'] } }
          },
        }
      }
      if (u.endsWith('/user/tokens/permission_groups')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              result: [{ id: 'grp-r2w', name: 'Workers R2 Storage Write' }],
            }
          },
        }
      }
      if (u.endsWith('/user/tokens') && method === 'POST') {
        createBody = JSON.parse(init.body)
        return {
          ok: true,
          status: 200,
          async json() {
            return { success: true, result: { id: 'AKIASTABLE', value: 'stable-token-value' } }
          },
        }
      }
      return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: () => ({
      async list() { return [] },
      async head() { return null },
      close() {},
    }),
  })
  const result = await io.deriveAndVerifyS3({})
  assert.equal(result.derived, true)
  assert.equal(result.accessKeyId, 'AKIASTABLE')
  assert.equal(createBody.name, 'airingcal-development-s3')
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

// ---------------------------------------------------------------------------
// Review item 5 (cluster 2): AIRINGCAL_IMAGE_BASE_URL must flow to readers
// and apply must verify the real 302 Location routing evidence.
// ---------------------------------------------------------------------------

const ROUTE_HASH = 'c'.repeat(64)

function routingSnapshotWithImage(hash) {
  return {
    collections: { watching: [{ images: { large: { hash } } }], want: [] },
    calendar: [{ items: [{ images: { large: null } }] }],
  }
}

function buildRoutingIo(fetchImpl, extraEnv = {}, target = 'both') {
  return import('./deploy-env.mjs').then(({ createLiveDevelopmentApplyIo }) =>
    createLiveDevelopmentApplyIo({
      env: {
        AIRINGCAL_CLOUDFLARE_API_TOKEN: 'routing-token',
        AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        ...extraEnv,
      },
      plan: buildDevelopmentDeployPlan({
        target,
        publicBaseUrl: 'https://dev-cdn.example.test',
        mode: 'apply',
      }),
      spawnSyncImpl: () => {
        throw new Error('spawn must not be used by verifyImageRouting')
      },
      fetchImpl,
    }),
  )
}

function routingFetchDouble({ location, imageStatus = 302, snapshot, calls = [] }) {
  return async (url, init = {}) => {
    const u = String(url)
    calls.push([u, init])
    if (u.endsWith('/public/current-release.json')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { artifact_ref: 'snapshots/v1/9-abc.json' }
        },
      }
    }
    if (u.includes('/snapshots/v1/')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return snapshot ?? routingSnapshotWithImage(ROUTE_HASH)
        },
      }
    }
    if (u.includes('/image/')) {
      return {
        ok: imageStatus >= 200 && imageStatus < 300,
        status: imageStatus,
        headers: {
          get: (name) =>
            String(name).toLowerCase() === 'location' && typeof location === 'string'
              ? location
              : null,
        },
        async json() {
          return {}
        },
      }
    }
    throw new Error(`verifyImageRouting: unexpected fetch ${u}`)
  }
}

function routingCtx(extra = {}) {
  return {
    cloudflareDeploy: { deployed: true, workerUrl: 'https://cf-reader.example.workers.dev' },
    edgeoneDeploy: { deployed: true, readerUrl: 'https://preview.edgeone.cool' },
    ...extra,
  }
}

test('verifyImageRouting passes when CF + EO 302 Location origins match AIRINGCAL_IMAGE_BASE_URL', async () => {
  const calls = []
  const io = await buildRoutingIo(
    routingFetchDouble({ location: `https://img.example.test/images/${ROUTE_HASH}/original`, calls }),
    { AIRINGCAL_IMAGE_BASE_URL: 'https://img.example.test' },
  )
  const receipt = await io.verifyImageRouting(routingCtx())
  assert.equal(receipt.hash, ROUTE_HASH)
  assert.deepEqual(
    receipt.readers.map((r) => r.base).sort(),
    ['https://cf-reader.example.workers.dev', 'https://preview.edgeone.cool'],
  )
  assert.ok(receipt.readers.every((r) => r.originMatches === true))
  assert.ok(receipt.readers.every((r) => r.location === `https://img.example.test/images/${ROUTE_HASH}/original`))
  const imageCalls = calls.filter(([u]) => u.includes('/image/'))
  assert.equal(imageCalls.length, 2)
  assert.ok(imageCalls.every(([, init]) => init.redirect === 'manual'))
  const pointerCall = calls.find(([u]) => u.endsWith('/public/current-release.json'))
  assert.match(String(pointerCall[1].headers?.['cache-control'] ?? ''), /no-cache/)
})

test('verifyImageRouting fails closed when readers redirect to the public host while image base is set', async () => {
  const io = await buildRoutingIo(
    routingFetchDouble({ location: `https://dev-cdn.example.test/images/${ROUTE_HASH}/original` }),
    { AIRINGCAL_IMAGE_BASE_URL: 'https://img.example.test' },
  )
  await assert.rejects(
    io.verifyImageRouting(routingCtx()),
    /image routing verification failed.*img\.example\.test/i,
  )
})

test('verifyImageRouting expects the public origin when AIRINGCAL_IMAGE_BASE_URL is unset', async () => {
  const io = await buildRoutingIo(
    routingFetchDouble({ location: `https://dev-cdn.example.test/images/${ROUTE_HASH}/original` }),
  )
  const receipt = await io.verifyImageRouting(routingCtx())
  assert.equal(receipt.hash, ROUTE_HASH)
  assert.ok(receipt.readers.every((r) => r.originMatches === true))
})

test('verifyImageRouting fails closed on non-302 reader responses', async () => {
  const io = await buildRoutingIo(
    routingFetchDouble({ location: undefined, imageStatus: 404 }),
    { AIRINGCAL_IMAGE_BASE_URL: 'https://img.example.test' },
  )
  await assert.rejects(io.verifyImageRouting(routingCtx()), /image routing verification failed/)
})

test('verifyImageRouting skips (not passes) when the published release has no images', async () => {
  const calls = []
  const io = await buildRoutingIo(
    routingFetchDouble({
      calls,
      snapshot: { collections: {}, calendar: [] },
    }),
    { AIRINGCAL_IMAGE_BASE_URL: 'https://img.example.test' },
  )
  const result = await io.verifyImageRouting(routingCtx())
  assert.equal(result.status, 'skipped-no-images')
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
  assert.ok(!calls.some(([u]) => u.includes('/image/')), 'readers must not be probed')
})

test('verifyImageRouting refuses with an explicit error when the EdgeOne host is unknown', async () => {
  const io = await buildRoutingIo(
    routingFetchDouble({ location: `https://dev-cdn.example.test/images/${ROUTE_HASH}/original` }),
  )
  await assert.rejects(
    io.verifyImageRouting({
      cloudflareDeploy: { deployed: true, workerUrl: 'https://cf-reader.example.workers.dev' },
      edgeoneDeploy: { deployed: true },
    }),
    /edgeone reader host unknown; set AIRINGCAL_EDGEONE_READER_URL for routing verification/,
  )
})

test('verifyImageRouting honours the AIRINGCAL_EDGEONE_READER_URL fallback when the deploy stdout has no URL', async () => {
  const io = await buildRoutingIo(
    routingFetchDouble({ location: `https://dev-cdn.example.test/images/${ROUTE_HASH}/original` }),
    { AIRINGCAL_EDGEONE_READER_URL: 'https://test.air.teijp.cn' },
  )
  const receipt = await io.verifyImageRouting({
    cloudflareDeploy: { deployed: true, workerUrl: 'https://cf-reader.example.workers.dev' },
    edgeoneDeploy: { deployed: true, readerUrl: null },
  })
  assert.ok(receipt.readers.some((r) => r.base === 'https://test.air.teijp.cn'))
})

test('verifyImageRouting propagates fetch errors fail-closed', async () => {
  const io = await buildRoutingIo(async (url) => {
    if (String(url).includes('/image/')) throw new Error('ECONNREFUSED')
    return {
      ok: true,
      status: 200,
      async json() {
        return String(url).includes('/snapshots/')
          ? routingSnapshotWithImage(ROUTE_HASH)
          : { artifact_ref: 'snapshots/v1/9-abc.json' }
      },
    }
  })
  await assert.rejects(io.verifyImageRouting(routingCtx()), /image routing verification failed/)
})

test('runDevelopmentApply captures deploy receipts into ctx for verifyImageRouting', async () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  let seen = null
  const io = createRecordingApplyIo({
    deployCloudflareReader: async () => ({ deployed: true, workerUrl: 'https://cf-worker.example.test' }),
    deployEdgeoneOverseas: async () => ({ deployed: true, readerUrl: 'https://eo-reader.example.test' }),
    verifyImageRouting: (ctx) => {
      seen = { cf: ctx.cloudflareDeploy, eo: ctx.edgeoneDeploy }
      return { hash: 'd'.repeat(64), readers: [] }
    },
  })
  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'routing-token',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
    io,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(seen?.cf?.workerUrl, 'https://cf-worker.example.test')
  assert.equal(seen?.eo?.readerUrl, 'https://eo-reader.example.test')
  assert.ok(result.completed.includes('image-routing-verify'))
})

test('runDevelopmentApply records skipped-no-images without completing the routing step', async () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createRecordingApplyIo({
    verifyImageRouting: async () => ({
      status: 'skipped-no-images',
      reason: 'current snapshot contains no image hashes',
    }),
  })
  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'routing-token',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
    io,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(!result.completed.includes('image-routing-verify'), 'skipped is not a pass')
  assert.ok(result.completed.includes('image-cdn-validate'))
  assert.equal(result.imageRouting?.status, 'skipped-no-images')
})

test('runDevelopmentApply propagates image routing verification failures', async () => {
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const io = createRecordingApplyIo({
    verifyImageRouting: async () => {
      throw new Error('image routing verification failed: CF 302 pointed at the public host')
    },
  })
  await assert.rejects(
    runDevelopmentApply({
      plan,
      env: {
        AIRINGCAL_CLOUDFLARE_API_TOKEN: 'routing-token',
        AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
      },
      io,
    }),
    /image routing verification failed/,
  )
})

test('deployCloudflareReader forwards the trimmed AIRINGCAL_IMAGE_BASE_URL to the materialize child env', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const runs = []
  const spawnSyncImpl = (cmd, args, opts) => {
    const joined = args.join(' ')
    if (joined.includes('materialize-v3-read-staging-config')) {
      runs.push({ ...(opts?.env ?? {}) })
      return { status: 0, stdout: '', stderr: 'wrote', error: null }
    }
    if (joined.includes('deploy') && joined.includes('--config')) {
      return { status: 0, stdout: 'Published https://reader.r7a.workers.dev', stderr: '', error: null }
    }
    return { status: 0, stdout: 'ok', stderr: '', error: null }
  }

  const ioSet = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'routing-token',
      AIRINGCAL_IMAGE_BASE_URL: '  https://img.example.test  ',
    },
    plan,
    spawnSyncImpl,
    fetchImpl: async () => {
      throw new Error('no fetch expected')
    },
  })
  const deployed = await ioSet.deployCloudflareReader()
  assert.equal(deployed.workerUrl, 'https://reader.r7a.workers.dev')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].AIRINGCAL_IMAGE_BASE_URL, 'https://img.example.test')

  runs.length = 0
  const ioUnset = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'routing-token' },
    plan,
    spawnSyncImpl,
    fetchImpl: async () => {
      throw new Error('no fetch expected')
    },
  })
  await ioUnset.deployCloudflareReader()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].AIRINGCAL_IMAGE_BASE_URL, '', 'unset must be explicit empty; never leak process.env')
})

test('deployEdgeoneOverseas sets the image base env pair only when configured and exposes readerUrl', async () => {
  const buildEdgeoneIo = (imageBaseUrl, spawnLog) =>
    import('./deploy-env.mjs').then(({ createLiveDevelopmentApplyIo }) =>
      createLiveDevelopmentApplyIo({
        env: {
          AIRINGCAL_CLOUDFLARE_API_TOKEN: 'routing-token',
          AIRINGCAL_EDGEONE_API_TOKEN: 'eo-tok',
          ...(imageBaseUrl ? { AIRINGCAL_IMAGE_BASE_URL: imageBaseUrl } : {}),
        },
        plan: buildDevelopmentDeployPlan({
          target: 'edgeone',
          publicBaseUrl: 'https://dev-cdn.example.test',
          mode: 'apply',
        }),
        spawnSyncImpl: (cmd, args) => {
          const joined = args.join(' ')
          spawnLog.push(`${cmd} ${joined}`)
          return {
            status: 0,
            stdout: cmd === 'edgeone' && joined.includes('deploy') ? 'Deployed at https://preview.edgeone.cool' : '',
            stderr: '',
            error: null,
          }
        },
        fetchImpl: async () => {
          throw new Error('no fetch expected')
        },
      }),
    )

  const withImage = []
  const ioWith = await buildEdgeoneIo('https://img.example.test', withImage)
  const resultWith = await ioWith.deployEdgeoneOverseas()
  assert.ok(
    withImage.some((l) => l.includes('env set AIRINGCAL_IMAGE_BASE_URL https://img.example.test')),
    withImage.join(' | '),
  )
  assert.equal(resultWith.readerUrl, 'https://preview.edgeone.cool')

  const withoutImage = []
  const ioWithout = await buildEdgeoneIo('', withoutImage)
  await ioWithout.deployEdgeoneOverseas()
  assert.ok(
    !withoutImage.some((l) => l.includes('AIRINGCAL_IMAGE_BASE_URL')),
    `image base must stay unset on EdgeOne when not configured: ${withoutImage.join(' | ')}`,
  )
})
