import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DEVELOPMENT_DEFAULTS,
  STAGING_ALIAS_MAP,
  applyStagingAliases,
  buildCorsAllowedOrigins,
  buildDevelopmentDeployPlan,
  deriveDevelopmentConfig,
  deriveProductionConfig,
  evaluateIsolationProbe,
  parseDeployArgs,
  resolveExecutionMode,
  runDevelopmentApply,
  validateImageCdnConfig,
} from './deploy-env-lib.mjs'
import {
  cfApi,
  copyPrefixes,
  formatCopyProgress,
  runGh,
  runWrangler,
  withNetworkRetry,
} from './deploy-env-live-io.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = resolve(ROOT, 'scripts', 'deploy-env.mjs')

// ---------------------------------------------------------------------------
// Hermetic `edgeone makers` CLI double for deployEdgeoneOverseas tests.
// Models the project's env-var store and reproduces the file side effects of
// `link` / `env set` / `env rm` / `env pull` / `deploy --json`, so the adapter
// can be exercised without network or a real Makers project. `env pull -f`
// writes the accumulated project env to `<dist>/.env` exactly as the real CLI
// does; the adapter reads that file back and fails closed on missing keys.
// ---------------------------------------------------------------------------
function createFakeEdgeone({
  log = [],
  initialEnv = {},
  deployOutput = '{"status":"success","url":"https://eo.example","deploymentId":"d1"}',
  pullOmitKeys = [],
  rmOutcome = null,
  onDeploy = null,
} = {}) {
  const projectEnv = new Map(Object.entries(initialEnv))
  const state = {
    projectEnv,
    cwds: [],
    linkCwd: null,
    deployCalls: 0,
    distEnvAtDeploy: null,
    pullTarget: null,
    calls: [],
  }
  const spawn = (cmd, args, opts = {}) => {
    const argList = Array.isArray(args) ? args : []
    const joined = argList.join(' ')
    state.calls.push({ cmd, args: argList, cwd: opts?.cwd ?? null })
    log.push(`${cmd} ${joined}`)
    if (opts?.cwd) state.cwds.push(opts.cwd)
    if (cmd === 'edgeone') {
      const sub = argList[1]
      if (sub === 'link') {
        state.linkCwd = opts?.cwd ?? null
      } else if (sub === 'env' && argList[2] === 'set') {
        projectEnv.set(argList[3], argList[4])
      } else if (sub === 'env' && argList[2] === 'rm') {
        projectEnv.delete(argList[3])
        return rmOutcome ? rmOutcome() : { status: 0, stdout: '', stderr: '', error: null }
      } else if (sub === 'env' && argList[2] === 'pull') {
        const f = argList.indexOf('-f')
        const target = f >= 0 ? argList[f + 1] : null
        state.pullTarget = target
        if (target) {
          const lines = []
          for (const [k, v] of projectEnv) {
            if (pullOmitKeys.includes(k)) continue
            lines.push(`${k}=${v}`)
          }
          const targetPath = resolve(opts?.cwd ?? process.cwd(), target)
          mkdirSync(dirname(targetPath), { recursive: true })
          writeFileSync(targetPath, lines.join('\n') + '\n')
        }
      } else if (sub === 'deploy') {
        state.deployCalls += 1
        const envFile = join(argList[2], '.env')
        const envExists = existsSync(envFile)
        state.distEnvAtDeploy = {
          envFile,
          exists: envExists,
          content: envExists ? readFileSync(envFile, 'utf8') : null,
        }
        if (onDeploy) onDeploy(state.distEnvAtDeploy)
      }
    }
    return { status: 0, stdout: cmd === 'edgeone' && argList[1] === 'deploy' ? deployOutput : '', stderr: '', error: null }
  }
  return { spawn, state, log }
}

function makeEdgeoneIo(fake, { env = {}, imageBaseUrl, target = 'edgeone', publicBaseUrl = 'https://dev-cdn.example.test' } = {}) {
  return import('./deploy-env.mjs').then(({ createLiveDevelopmentApplyIo }) =>
    createLiveDevelopmentApplyIo({
      env: {
        AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
        AIRINGCAL_EDGEONE_API_TOKEN: 'eo-tok',
        ...(imageBaseUrl ? { AIRINGCAL_IMAGE_BASE_URL: imageBaseUrl } : {}),
        ...env,
      },
      plan: buildDevelopmentDeployPlan({ target, publicBaseUrl, mode: 'apply' }),
      spawnSyncImpl: fake.spawn,
      fetchImpl: async () => {
        throw new Error('no fetch expected')
      },
    }),
  )
}

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

test('production env refuses staging/development secret aliases', () => {
  assert.throws(
    () => deriveProductionConfig({
      AIRINGCAL_ENV: 'production',
      AIRINGCAL_STAGING_BANGUMI_TOKEN: 'x',
      // missing AIRINGCAL_BANGUMI_TOKEN
    }),
    /must not alias|AIRINGCAL_BANGUMI_TOKEN/,
  )
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
  let printed = ''
  const origWrite = process.stderr.write
  process.stderr.write = (chunk) => { printed += String(chunk); return true }
  let derived
  try {
    derived = await io.deriveAndVerifyS3({})
  } finally {
    process.stderr.write = origWrite
  }
  assert.equal(derived.accessKeyId, 'AKIA_OVERRIDE')
  assert.equal(derived.derived, false)
  assert.equal(derived.verified, true)
  assert.equal(storeCalls[0]?.accessKeyId, 'AKIA_OVERRIDE')
  assert.ok(!printed.includes('override rejected'), 'valid override must not announce fall-through')
})

test('deriveAndVerifyS3 falls through to management-token self-derivation when the S3 override is rejected', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const parentToken = 'mgmt-token-value'
  const fetchLog = []
  const triedKeys = []
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: parentToken,
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      AIRINGCAL_S3_ACCESS_KEY_ID: 'AKIA_STAGING_SCOPED',
      AIRINGCAL_S3_SECRET_ACCESS_KEY: 'staging-scoped-secret',
    },
    plan,
    spawnSyncImpl: () => {
      throw new Error('gh/wrangler must not run on the override fall-through path')
    },
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      fetchLog.push([String(init.method ?? 'GET'), u])
      if (u.endsWith('/user/tokens/verify')) {
        return {
          ok: true,
          status: 200,
          async json() { return { success: true, result: { id: VERIFY_TOKEN_ID, status: 'active' } } },
        }
      }
      return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: (config) => ({
      async list() {
        triedKeys.push(config.accessKeyId)
        if (config.accessKeyId === 'AKIA_STAGING_SCOPED') {
          const err = new Error('AccessDenied: this key cannot access the specified bucket')
          err.$metadata = { httpStatusCode: 403 }
          throw err
        }
        return []
      },
      async head() { return null },
      close() {},
    }),
  })
  let printed = ''
  const origWrite = process.stderr.write
  process.stderr.write = (chunk) => { printed += String(chunk); return true }
  const ctx = {}
  let result
  try {
    result = await io.deriveAndVerifyS3(ctx)
  } finally {
    process.stderr.write = origWrite
  }
  assert.equal(result.derived, true)
  assert.equal(result.source, 'management-token')
  assert.equal(result.accessKeyId, VERIFY_TOKEN_ID)
  assert.equal(result.verified, true)
  assert.ok(
    printed.includes('AIRINGCAL_S3_* override rejected for airingcal-development; falling through to management-token self-derivation'),
    'stderr must carry the fall-through notice',
  )
  assert.ok(triedKeys[0] === 'AKIA_STAGING_SCOPED', 'override creds are tried first (precedence kept)')
  assert.ok(triedKeys.includes(VERIFY_TOKEN_ID), 'self-derived creds must be verified')
  assert.ok(fetchLog.some(([m, u]) => m === 'GET' && u.endsWith('/user/tokens/verify')), 'management-token endpoint must be reached')
  assert.equal(typeof ctx.s3OverrideRejection, 'string', 'runner needs the rejection note for aggregated abort reasons')
  assert.ok(!printed.includes(parentToken) && !printed.includes('staging-scoped-secret'), 'secrets must never be printed')
})

test('deriveAndVerifyS3 rethrows non-credential override failures without falling through', async () => {
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
      AIRINGCAL_S3_ACCESS_KEY_ID: 'AKIA_OVERRIDE',
      AIRINGCAL_S3_SECRET_ACCESS_KEY: 'override-secret',
    },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async (url) => {
      fetchLog.push(String(url))
      throw new Error('CF API must not be reached when the override probe fails on transport')
    },
    createObjectStore: () => ({
      async list() {
        throw new TypeError('fetch failed: ECONNRESET')
      },
      async head() { return null },
      close() {},
    }),
  })
  const ctx = {}
  await assert.rejects(
    () => io.deriveAndVerifyS3(ctx),
    (error) => {
      assert.ok(error instanceof TypeError, 'network-style error must be rethrown as-is')
      assert.match(error.message, /ECONNRESET/)
      return true
    },
  )
  assert.deepEqual(fetchLog, [], 'fail-closed: no fall-through to self-derivation')
  assert.ok(!('s3OverrideRejection' in ctx))
})

test('runDevelopmentApply aggregates override rejection + chain failure into the exit-2 abort reason', async () => {
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
      AIRINGCAL_S3_ACCESS_KEY_ID: 'AKIA_STAGING_SCOPED',
      AIRINGCAL_S3_SECRET_ACCESS_KEY: 'staging-scoped-secret',
    },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl: async (url) => {
      const u = String(url)
      if (u.endsWith('/user/tokens/verify')) {
        return {
          ok: true,
          status: 200,
          async json() { return { success: true, result: { id: VERIFY_TOKEN_ID, status: 'active' } } },
        }
      }
      if (u.endsWith('/user/tokens/permissions')) {
        return {
          ok: false,
          status: 403,
          async json() { return { success: false, errors: [{ code: 10000, message: 'Unauthorized to create tokens' }] } },
        }
      }
      return { ok: false, status: 403, async json() { return { success: false, errors: [] } } }
    },
    createObjectStore: () => ({
      async list() {
        const err = new Error('AccessDenied: scoped key lacks this bucket')
        err.$metadata = { httpStatusCode: 403 }
        throw err
      },
      async head() { return null },
      close() {},
    }),
  })
  io.probeToken = async () => ({ ok: true, missingScopes: [] })
  const origWrite = process.stderr.write
  process.stderr.write = () => true
  let result
  try {
    result = await runDevelopmentApply({
      plan,
      env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes' },
      io,
    })
  } finally {
    process.stderr.write = origWrite
  }
  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
  assert.equal(result.abortCutover, true)
  assert.equal(result.dualBucketFallback, false)
  assert.equal(result.exitCode, 2, 'exit-2 semantics preserved')
  assert.match(result.reason, /override rejected/, 'abort reason must carry the override story')
  assert.match(result.reason, /User API Tokens: Edit/, 'abort reason must carry the create-denied scope label')
  assert.ok(Array.isArray(result.missingScopes) && result.missingScopes.length > 0)
})

test('createLiveDevelopmentApplyIo applyCors writes Wrangler rules file with exact origins', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const EXPECTED_ORIGINS = [
    'https://airing-cal-v3-read-staging.r7a.workers.dev',
    'https://dev-cdn.example.test',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
  ]
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
        // Wrangler requires a top-level { rules: [...] } object, never a bare REST array.
        assert.ok(!Array.isArray(parsed), 'cors file must not be a bare array')
        assert.ok(!('AllowedOrigins' in parsed), 'no bare AllowedOrigins key at top level')
        assert.ok(!('AllowedMethods' in parsed), 'no bare AllowedMethods key at top level')
        assert.ok(Array.isArray(parsed.rules), 'parsed.rules must be an array')
        const rule = parsed.rules[0]
        assert.deepEqual(rule.allowed.origins, EXPECTED_ORIGINS)
        assert.deepEqual(rule.allowed.methods, ['GET', 'HEAD'])
        assert.ok(!rule.allowed.methods.includes('OPTIONS'), 'no OPTIONS in allowed.methods')
        assert.ok(!rule.allowed.origins.some((o) => o.includes('*')), 'no wildcard origins')
        assert.deepEqual(rule.exposeHeaders, ['ETag', 'Content-Type', 'Content-Length'])
        assert.equal(rule.maxAgeSeconds, 86400)
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
  assert.equal(result.alreadyFrozen, false)
  assert.ok(ghCalls.some((c) => c.includes('workflow disable')))
  assert.ok(ghCalls.some((c) => c.includes('run list')))
})

test('freezeWriter treats already-disabled workflow as success and records alreadyFrozen', async () => {
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
        return {
          status: 1,
          stdout: '',
          stderr: 'Unable to disable a workflow that is not active (HTTP 403)',
          error: null,
        }
      }
      if (args.includes('run') && args.includes('list')) {
        return { status: 0, stdout: '[]', stderr: '', error: null }
      }
      return { status: 0, stdout: '', stderr: '', error: null }
    },
    fetchImpl: async () => ({ status: 403 }),
  })
  const result = await io.freezeWriter({})
  assert.equal(result.lever, 'workflow-disable')
  assert.equal(result.alreadyFrozen, true)
  assert.equal(result.inProgress, 0)
  assert.ok(
    ghCalls.some((c) => c.includes('run list')),
    'already-disabled no-op must still wait for in_progress runs',
  )
})

test('freezeWriter fails closed on auth errors from workflow disable', async () => {
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
        return { status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)', error: null }
      }
      return { status: 0, stdout: '', stderr: '', error: null }
    },
    fetchImpl: async () => ({ status: 403 }),
  })
  await assert.rejects(() => io.freezeWriter({}), /Bad credentials/)
  assert.ok(
    !ghCalls.some((c) => c.includes('run list')),
    'fatal disable failure must not proceed to the run-list wait',
  )
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
  // 'deployed' has no URL / JSON so readerUrl stays null and verifyImageRouting
  // falls back to AIRINGCAL_EDGEONE_READER_URL, preserving the original receipt.
  const eoFake = createFakeEdgeone({ deployOutput: 'deployed' })
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
        return eoFake.spawn(cmd, args, opts)
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

test('runSingleWriterTest proceeds to dispatch when enable is an already-enabled no-op', async () => {
  const inner = writerTestSpawnDouble({ jobs: [{ name: 'development', conclusion: 'success' }] })
  const spawnSyncImpl = (cmd, args) => {
    const joined = args.join(' ')
    if (joined.includes('workflow enable')) {
      inner.ghCalls.push(joined)
      return {
        status: 1,
        stdout: '',
        stderr: 'Unable to enable a workflow that is not disabled (HTTP 403)',
        error: null,
      }
    }
    return inner.spawnSyncImpl(cmd, args)
  }
  const io = await buildWriterTestIo(spawnSyncImpl)
  const receipt = await io.runSingleWriterTest({})
  assert.equal(receipt.dispatched, true)
  assert.equal(receipt.runId, 101)
  assert.equal(receipt.restored, true)
  assert.ok(
    inner.ghCalls.some((c) => c.includes('workflow enable')),
    'enable toggle must still be attempted',
  )
  assert.ok(inner.ghCalls.some((c) => c.includes('workflow run portable-writer.yml')))
})

test('runSingleWriterTest restore treats already-disabled workflow as success, not a restore failure', async () => {
  const inner = writerTestSpawnDouble({ jobs: [{ name: 'development', conclusion: 'success' }] })
  const spawnSyncImpl = (cmd, args) => {
    const joined = args.join(' ')
    if (joined.includes('workflow disable')) {
      inner.ghCalls.push(joined)
      return {
        status: 1,
        stdout: '',
        stderr: 'Unable to disable a workflow that is not active (HTTP 403)',
        error: null,
      }
    }
    return inner.spawnSyncImpl(cmd, args)
  }
  const io = await buildWriterTestIo(spawnSyncImpl)
  const receipt = await io.runSingleWriterTest({})
  assert.equal(receipt.restored, true)
  assert.ok(inner.ghCalls.some((c) => c.includes('workflow disable')))
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
  assert.equal(waf.rules[0].action, 'block')
  assert.ok(
    !waf.rules[0].action_parameters?.response,
    'checkpoint deny rule must not request the paid custom response body',
  )
  assert.ok(
    immutable.rules[0].action_parameters,
    'cache rules keep their allowed action_parameters',
  )
  assert.ok(pointer.rules[0].action_parameters)
})

// --- ensureZonePhaseRule expression reconciliation -------------------------

const OLD_ZONE_WIDE_WAF = '(starts_with(http.request.uri.path, "/checkpoints/"))'
const OLD_ZONE_WIDE_IMMUTABLE =
  '(starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/snapshots/"))'
const OLD_ZONE_WIDE_POINTER = '(http.request.uri.path eq "/public/current-release.json")'
const NEW_HOST_WAF =
  '(http.host eq "dev-cdn.example.test" and starts_with(http.request.uri.path, "/checkpoints/"))'
const NEW_HOST_IMMUTABLE =
  '(http.host eq "dev-cdn.example.test" and (starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/snapshots/")))'
const NEW_HOST_POINTER =
  '(http.host eq "dev-cdn.example.test" and http.request.uri.path eq "/public/current-release.json")'

function makeSeededZoneFetch({ cacheRules, wafRules } = {}) {
  const writes = []
  const entrypoints = {
    http_request_cache_settings: cacheRules
      ? { id: 'rs-cache', phase: 'http_request_cache_settings', rules: cacheRules }
      : null,
    http_request_firewall_custom: wafRules
      ? { id: 'rs-waf', phase: 'http_request_firewall_custom', rules: wafRules }
      : null,
  }
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const method = String(init.method ?? 'GET')
    const phaseMatch = u.match(/\/rulesets\/phases\/([a-z_]+)\/entrypoint/)
    if (phaseMatch) {
      const entry = entrypoints[phaseMatch[1]]
      if (!entry) {
        return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
      }
      return { ok: true, status: 200, async json() { return { success: true, result: entry } } }
    }
    if (method === 'PATCH' && /\/rulesets\/[^/]+\/rules\/[^/]+$/.test(u)) {
      writes.push({ method, url: u, body: JSON.parse(init.body) })
      return { ok: true, status: 200, async json() { return { success: true, result: {} } } }
    }
    if (method === 'POST' && u.includes('/rulesets')) {
      writes.push({ method, url: u, body: JSON.parse(init.body) })
      return {
        ok: true,
        status: 200,
        async json() { return { success: true, result: { id: 'rs-new', rules: [] } } },
      }
    }
    return { ok: true, status: 200, async json() { return { success: true, result: {} } } }
  }
  return { writes, fetchImpl }
}

test('configureWaf PATCHes zone-wide rule when description matches but expression changed', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const { writes, fetchImpl } = makeSeededZoneFetch({
    wafRules: [
      {
        id: 'rule-deny',
        description: 'airingcal-deny-checkpoints',
        expression: OLD_ZONE_WIDE_WAF,
        action: 'block',
        enabled: true,
      },
    ],
  })
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_ZONE_ID: 'zone123' },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl,
  })

  const result = await io.configureWaf({})

  assert.equal(result.rule.updated, true)
  assert.equal(result.rule.reused, undefined)
  assert.equal(result.rule.created, false)
  assert.equal(result.rule.reason, 'expression-changed')
  assert.equal(result.rule.rulesetId, 'rs-waf')
  assert.equal(result.rule.ruleId, 'rule-deny')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, 'PATCH')
  assert.ok(writes[0].url.includes('/zones/zone123/rulesets/rs-waf/rules/rule-deny'))
  assert.equal(writes[0].body.expression, NEW_HOST_WAF)
  assert.equal(writes[0].body.description, 'airingcal-deny-checkpoints')
  assert.equal(writes[0].body.action, 'block')
  assert.ok(
    !writes[0].body.action_parameters?.response,
    'checkpoint deny rule must not request the paid custom response body',
  )
  assert.equal(writes[0].body.enabled, true)
})

test('applyCacheRules PATCHes both stale cache rules (immutable + pointer) on expression change', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const { writes, fetchImpl } = makeSeededZoneFetch({
    cacheRules: [
      {
        id: 'rule-imm',
        description: 'airingcal-images-snapshots-immutable',
        expression: OLD_ZONE_WIDE_IMMUTABLE,
        action: 'set_cache_settings',
        enabled: true,
      },
      {
        id: 'rule-ptr',
        description: 'airingcal-pointer-bypass',
        expression: OLD_ZONE_WIDE_POINTER,
        action: 'set_cache_settings',
        enabled: true,
      },
    ],
  })
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_ZONE_ID: 'zone123' },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl,
  })

  const result = await io.applyCacheRules({})

  assert.equal(result.immutable.updated, true)
  assert.equal(result.immutable.reused, undefined)
  assert.equal(result.immutable.reason, 'expression-changed')
  assert.equal(result.pointer.updated, true)
  assert.equal(result.pointer.reused, undefined)
  assert.equal(result.pointer.reason, 'expression-changed')
  assert.equal(writes.length, 2)
  assert.ok(writes.every((w) => w.method === 'PATCH'))
  const imm = writes.find((w) => w.url.includes('/rules/rule-imm'))
  const ptr = writes.find((w) => w.url.includes('/rules/rule-ptr'))
  assert.ok(imm && ptr, 'expected PATCHes keyed to both seeded rule ids')
  assert.equal(imm.body.expression, NEW_HOST_IMMUTABLE)
  assert.deepEqual(imm.body.action_parameters, {
    cache: true,
    edge_ttl: { mode: 'override_origin', default: 31536000 },
    browser_ttl: { mode: 'override_origin', default: 31536000 },
  })
  assert.equal(ptr.body.expression, NEW_HOST_POINTER)
  assert.deepEqual(ptr.body.action_parameters, { cache: false })
})

test('ensureZonePhaseRule reuses with zero writes only when description AND expression match', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const { writes, fetchImpl } = makeSeededZoneFetch({
    cacheRules: [
      {
        id: 'rule-imm',
        description: 'airingcal-images-snapshots-immutable',
        expression: NEW_HOST_IMMUTABLE,
        action: 'set_cache_settings',
        enabled: true,
      },
      {
        id: 'rule-ptr',
        description: 'airingcal-pointer-bypass',
        expression: NEW_HOST_POINTER,
        action: 'set_cache_settings',
        enabled: true,
      },
    ],
    wafRules: [
      {
        id: 'rule-deny',
        description: 'airingcal-deny-checkpoints',
        expression: NEW_HOST_WAF,
        action: 'block',
        enabled: true,
      },
    ],
  })
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_ZONE_ID: 'zone123' },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl,
  })

  const waf = await io.configureWaf({})
  const cache = await io.applyCacheRules({})

  assert.equal(waf.rule.reused, true)
  assert.equal(waf.rule.updated, undefined)
  assert.equal(cache.immutable.reused, true)
  assert.equal(cache.immutable.updated, undefined)
  assert.equal(cache.pointer.reused, true)
  assert.equal(cache.pointer.updated, undefined)
  assert.equal(writes.length, 0)
})

test('ensureZonePhaseRule still creates via POST when entrypoint has no matching rule', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const { writes, fetchImpl } = makeSeededZoneFetch({
    wafRules: [
      { id: 'rule-other', description: 'unrelated-rule', expression: 'true', action: 'block', enabled: true },
    ],
  })
  const io = createLiveDevelopmentApplyIo({
    env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_ZONE_ID: 'zone123' },
    plan,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
    fetchImpl,
  })

  const result = await io.configureWaf({})

  assert.equal(result.rule.created, true)
  assert.equal(result.rule.reused, undefined)
  assert.equal(result.rule.updated, undefined)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].method, 'POST')
  assert.ok(writes[0].url.includes('/zones/zone123/rulesets/rs-waf/rules'))
  assert.equal(writes[0].body.expression, NEW_HOST_WAF)
  assert.equal(writes[0].body.action, 'block')
  assert.ok(
    !writes[0].body.action_parameters?.response,
    'checkpoint deny rule must not request the paid custom response body',
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

// --- zone-scoped 10000 auth errors: actionable missing-capability messages ----

/**
 * Reproduce the response a token with Zone:Edit but no fine-grained Cache
 * Rules / WAF Custom Rules / DNS scopes gets on a /zones/... request:
 * HTTP 403 { success:false, errors:[{ code:10000, message:'Authentication error' }] }.
 */
function zoneScopeAuthFetchDouble(calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method ?? 'GET') })
    return {
      ok: false,
      status: 403,
      async json() {
        return { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }
      },
    }
  }
}

const ZONE_SCOPE_MESSAGE_RE = /zone-scoped Cache Rules \/ WAF Custom Rules \/ DNS Edit permissions/
const PROFILE_HINT_RE = /dash\.cloudflare\.com\/profile\/api-tokens/

function zoneScopeLiveIo(fetchImpl) {
  return import('./deploy-env.mjs').then(({ createLiveDevelopmentApplyIo }) =>
    createLiveDevelopmentApplyIo({
      env: { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok', AIRINGCAL_ZONE_ID: 'zone123' },
      plan: buildDevelopmentDeployPlan({
        target: 'both',
        publicBaseUrl: 'https://dev-cdn.example.test',
        mode: 'apply',
      }),
      spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '', error: null }),
      fetchImpl,
    }),
  )
}

test('applyCacheRules turns a Cloudflare 10000 auth error into an actionable missing-capability', async () => {
  const calls = []
  const io = await zoneScopeLiveIo(zoneScopeAuthFetchDouble(calls))
  await assert.rejects(
    () => io.applyCacheRules({}),
    (error) => {
      assert.equal(error.name, 'MissingCapabilityError')
      assert.match(String(error.message), /missing capability: cache-rules/)
      assert.match(String(error.message), ZONE_SCOPE_MESSAGE_RE)
      assert.match(String(error.message), PROFILE_HINT_RE)
      return true
    },
  )
  assert.equal(
    calls.filter((c) => c.method === 'POST').length,
    0,
    'no ruleset POST attempted on 10000 auth error',
  )
})

test('configureWaf turns a Cloudflare 10000 auth error into an actionable missing-capability', async () => {
  const calls = []
  const io = await zoneScopeLiveIo(zoneScopeAuthFetchDouble(calls))
  await assert.rejects(
    () => io.configureWaf({}),
    (error) => {
      assert.equal(error.name, 'MissingCapabilityError')
      assert.match(String(error.message), /missing capability: waf-checkpoints/)
      assert.match(String(error.message), ZONE_SCOPE_MESSAGE_RE)
      assert.match(String(error.message), PROFILE_HINT_RE)
      return true
    },
  )
  assert.equal(
    calls.filter((c) => c.method === 'POST').length,
    0,
    'no ruleset POST attempted on 10000 auth error',
  )
})

test('runner aborts cutover (no dual-bucket fallback) when applyCacheRules hits a zone-scope 10000 error', async () => {
  const realIo = await zoneScopeLiveIo(zoneScopeAuthFetchDouble([]))
  const io = createRecordingApplyIo({
    applyCacheRules: () => realIo.applyCacheRules({}),
  })
  const plan = buildDevelopmentDeployPlan({
    target: 'both',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const result = await runDevelopmentApply({
    plan,
    env: {
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok',
      AIRINGCAL_DEPLOY_LIVE_CONFIRM: 'yes',
    },
    io,
  })
  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
  assert.equal(result.abortCutover, true)
  assert.equal(result.dualBucketFallback, false)
  assert.equal(result.exitCode, 2)
  assert.equal(result.status, 'missing-capability')
  assert.match(String(result.reason), ZONE_SCOPE_MESSAGE_RE)
  assert.ok(!io.calls.includes('copy-public'))
  assert.ok(!io.calls.includes('copy-checkpoints'))
})

test('isZoneScopeError matches only Cloudflare 10000 auth errors from zone requests', async () => {
  const { isZoneScopeError } = await import('./deploy-env-live-io.mjs')
  const zoneErr = Object.assign(new Error('10000 Authentication error'), {
    errors: [{ code: 10000, message: 'Authentication error' }],
    zoneScopeHint: true,
    path: '/zones/z/rulesets',
  })
  assert.equal(isZoneScopeError(zoneErr), true)
  // Flattened message form (structured errors absent).
  assert.equal(
    isZoneScopeError(Object.assign(new Error('10000 Authentication error'), { zoneScopeHint: true })),
    true,
  )
  // Wrong code, wrong message, non-zone path, and network errors never match.
  assert.equal(
    isZoneScopeError(Object.assign(new Error('9106 Invalid API Token scopes'), {
      errors: [{ code: 9106, message: 'Invalid API Token scopes' }],
      path: '/user/tokens/verify',
    })),
    false,
  )
  assert.equal(
    isZoneScopeError(Object.assign(new Error('10000 not found'), {
      errors: [{ code: 10000, message: 'not found' }],
      path: '/zones/z/rulesets',
    })),
    false,
  )
  assert.equal(
    isZoneScopeError(Object.assign(new Error('10000 Authentication error'), {
      errors: [{ code: 10000, message: 'Authentication error' }],
      path: '/user/tokens/verify',
    })),
    false,
    'zone-scope message must not apply to other endpoints',
  )
  assert.equal(isZoneScopeError(new TypeError('fetch failed')), false)
  assert.equal(isZoneScopeError(null), false)
})

test('cfApi marks /zones/ 10000 failures with a zoneScopeHint', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    async json() {
      return { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }
    },
  })
  await assert.rejects(
    cfApi(fetchImpl, 'tok', '/zones/z/rulesets', {}, { sleep: async () => {} }),
    (error) => {
      assert.ok(error.zoneScopeHint, 'zoneScopeHint set on /zones/ 10000 failure')
      return true
    },
  )
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
      sleepImpl: async () => {},
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

test('verifyImageRouting returns skipped-no-images before any reader-host gating when the release has no images', async () => {
  for (const target of ['edgeone', 'both']) {
    const io = await buildRoutingIo(
      routingFetchDouble({ snapshot: { collections: {}, calendar: [] } }),
      {},
      target,
    )
    const result = await io.verifyImageRouting({
      cloudflareDeploy: { deployed: true },
      edgeoneDeploy: { deployed: true },
    })
    assert.equal(result.status, 'skipped-no-images', `${target}: zero hashes must skip`)
  }
})

test('verifyImageRouting still refuses with an explicit error when hashes exist and the EdgeOne host is unknown for target=edgeone', async () => {
  const io = await buildRoutingIo(
    routingFetchDouble({ location: `https://dev-cdn.example.test/images/${ROUTE_HASH}/original` }),
    {},
    'edgeone',
  )
  await assert.rejects(
    io.verifyImageRouting({ edgeoneDeploy: { deployed: true } }),
    /edgeone reader host unknown; set AIRINGCAL_EDGEONE_READER_URL for routing verification/,
  )
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
  // Plain-URL stdout (not --json) exercises the readerUrl regex fallback.
  const fakeWith = createFakeEdgeone({ deployOutput: 'Deployed at https://preview.edgeone.cool' })
  const ioWith = await makeEdgeoneIo(fakeWith, { imageBaseUrl: 'https://img.example.test' })
  const resultWith = await ioWith.deployEdgeoneOverseas()
  assert.ok(
    fakeWith.log.some((l) => l.includes('env set AIRINGCAL_IMAGE_BASE_URL https://img.example.test')),
    fakeWith.log.join(' | '),
  )
  assert.ok(
    !fakeWith.log.some((l) => l.includes('env rm AIRINGCAL_IMAGE_BASE_URL')),
    `configured image base must not be cleared: ${fakeWith.log.join(' | ')}`,
  )
  assert.match(String(fakeWith.state.distEnvAtDeploy?.content ?? ''), /AIRINGCAL_IMAGE_BASE_URL=https:\/\/img\.example\.test/)
  assert.equal(resultWith.readerUrl, 'https://preview.edgeone.cool')
  assert.equal(resultWith.imageBaseUrlPersisted, true)
  assert.equal(resultWith.imageBaseUrlCleared, false)
  assert.equal(existsSync(fakeWith.state.distEnvAtDeploy.envFile), false)

  const fakeWithout = createFakeEdgeone({ deployOutput: 'Deployed at https://preview.edgeone.cool' })
  const ioWithout = await makeEdgeoneIo(fakeWithout)
  const resultWithout = await ioWithout.deployEdgeoneOverseas()
  assert.ok(
    !fakeWithout.log.some((l) => l.includes('env set AIRINGCAL_IMAGE_BASE_URL')),
    `unset must never re-set a sticky image base: ${fakeWithout.log.join(' | ')}`,
  )
  assert.ok(
    fakeWithout.log.some(
      (l) =>
        l.includes('env rm AIRINGCAL_IMAGE_BASE_URL') &&
        l.includes('-e production') &&
        l.includes('-t eo-tok'),
    ),
    `unset must clear the persisted EdgeOne image base: ${fakeWithout.log.join(' | ')}`,
  )
  assert.equal(resultWithout.imageBaseUrlCleared, true)
  assert.equal(resultWithout.imageBaseUrlPersisted, false)
})

test('deployEdgeoneOverseas tolerates env rm "not found" output as an already-cleared base', async () => {
  const fake = createFakeEdgeone({
    rmOutcome: () => ({ status: 1, stdout: '', stderr: 'variable AIRINGCAL_IMAGE_BASE_URL not found', error: null }),
  })
  const io = await makeEdgeoneIo(fake)
  const result = await io.deployEdgeoneOverseas()
  assert.equal(result.imageBaseUrlCleared, true)
  assert.ok(fake.log.some((l) => l.includes('env rm AIRINGCAL_IMAGE_BASE_URL')))
  assert.equal(fake.state.deployCalls, 1, 'not-found env rm must not abort the deploy')
})

test('deployEdgeoneOverseas fails closed on a real env rm error (auth)', async () => {
  const fake = createFakeEdgeone({
    rmOutcome: () => ({ status: 1, stdout: '', stderr: '401 Unauthorized: invalid api token', error: null }),
  })
  const io = await makeEdgeoneIo(fake)
  await assert.rejects(io.deployEdgeoneOverseas(), /env rm AIRINGCAL_IMAGE_BASE_URL failed \(exit 1\).*Unauthorized/i)
  assert.equal(fake.state.deployCalls, 0, 'must not deploy after a real env rm error')
})

test('deployEdgeoneOverseas links, pulls env into dist/.env, deploys with --json in order, then cleans up', async () => {
  const fake = createFakeEdgeone({
    deployOutput: '{"status":"success","url":"https://eo.example","deploymentId":"d1"}',
  })
  const io = await makeEdgeoneIo(fake, { imageBaseUrl: 'https://img.example.test' })
  const result = await io.deployEdgeoneOverseas()
  const order = fake.log
  const linkIdx = order.findIndex((l) => l.includes('makers link'))
  const firstSetIdx = order.findIndex((l) => l.includes('env set'))
  const pullIdx = order.findIndex((l) => l.includes('env pull'))
  const deployIdx = order.findIndex((l) => l.includes('makers deploy'))
  assert.ok(linkIdx >= 0, `link must run: ${order.join(' | ')}`)
  assert.ok(firstSetIdx > linkIdx, `link must precede every env set: ${order.join(' | ')}`)
  assert.ok(pullIdx > firstSetIdx, `env pull must follow env mutations: ${order.join(' | ')}`)
  assert.ok(deployIdx > pullIdx, `deploy must follow env pull: ${order.join(' | ')}`)
  const linkCall = fake.state.calls.find((c) => c.cmd === 'edgeone' && c.args[1] === 'link')
  assert.deepEqual(linkCall.args, ['makers', 'link', '-n', 'airingcal-edgeone-read-overseas', '-a', 'overseas', '-t', 'eo-tok'])
  const pullCall = fake.state.calls.find((c) => c.cmd === 'edgeone' && c.args[2] === 'pull')
  assert.deepEqual(pullCall.args.slice(0, 7), ['makers', 'env', 'pull', '-e', 'production', '-t', 'eo-tok'])
  assert.equal(pullCall.args[7], '-f')
  assert.equal(pullCall.args[8], '.env', 'env pull must use -f .env relative to linked cwd')
  const deployCall = fake.state.calls.find((c) => c.cmd === 'edgeone' && c.args[1] === 'deploy')
  const distDir = fake.state.distEnvAtDeploy.envFile.replace(/\/\.env$/, '')
  assert.deepEqual(deployCall.args.slice(1), ['deploy', distDir, '-n', 'airingcal-edgeone-read-overseas', '-a', 'overseas', '-t', 'eo-tok', '-e', 'production', '--json'])
  // link / set / rm / pull / deploy all run from the same linked temp cwd.
  const edgeoneCwds = fake.state.calls.filter((c) => c.cmd === 'edgeone').map((c) => c.cwd)
  assert.ok(edgeoneCwds.every((c) => c && c === edgeoneCwds[0]), 'all edgeone calls must share the linked temp cwd')
  assert.equal(fake.state.distEnvAtDeploy.exists, true, 'dist/.env must be bundled at deploy time')
  const envContent = String(fake.state.distEnvAtDeploy.content ?? '')
  assert.match(envContent, /AIRINGCAL_PUBLIC_BASE_URL=https:\/\/dev-cdn\.example\.test/)
  assert.match(envContent, /NSFW_SHOW=false/)
  assert.match(envContent, /AIRINGCAL_IMAGE_BASE_URL=https:\/\/img\.example\.test/)
  assert.equal(existsSync(fake.state.distEnvAtDeploy.envFile), false, 'dist/.env must be removed after deploy')
  assert.ok(fake.state.linkCwd && fake.state.linkCwd.startsWith(tmpdir()), `link cwd must be a temp dir: ${fake.state.linkCwd}`)
  assert.equal(existsSync(fake.state.linkCwd), false, 'linked temp dir must be cleaned up')
  assert.equal(fake.state.deployCalls, 1)
  assert.equal(result.deployed, true)
  assert.equal(result.project, 'airingcal-edgeone-read-overseas')
  assert.equal(result.region, 'overseas')
})

test('deployEdgeoneOverseas takes readerUrl from --json url and falls back to a stdout URL', async () => {
  const jsonFake = createFakeEdgeone({ deployOutput: '{"status":"success","url":"https://eo.example","deploymentId":"d1"}' })
  const jsonResult = await (await makeEdgeoneIo(jsonFake)).deployEdgeoneOverseas()
  assert.equal(jsonResult.readerUrl, 'https://eo.example')
  const regexFake = createFakeEdgeone({ deployOutput: 'Deployed at https://preview.edgeone.cool' })
  const regexResult = await (await makeEdgeoneIo(regexFake)).deployEdgeoneOverseas()
  assert.equal(regexResult.readerUrl, 'https://preview.edgeone.cool')
})

test('deployEdgeoneOverseas clears a sticky image base on unset and keeps it when set', async () => {
  const unsetFake = createFakeEdgeone({ initialEnv: { AIRINGCAL_IMAGE_BASE_URL: 'https://sticky.example.test' } })
  const unsetRes = await (await makeEdgeoneIo(unsetFake)).deployEdgeoneOverseas()
  assert.ok(
    unsetFake.log.some((l) => l.includes('env rm AIRINGCAL_IMAGE_BASE_URL') && l.includes('-e production') && l.includes('-t eo-tok')),
    unsetFake.log.join(' | '),
  )
  assert.equal(unsetRes.imageBaseUrlCleared, true)
  assert.equal(unsetRes.imageBaseUrlPersisted, false)
  assert.equal(unsetFake.state.projectEnv.has('AIRINGCAL_IMAGE_BASE_URL'), false, 'env rm must clear the sticky project var')
  assert.ok(!String(unsetFake.state.distEnvAtDeploy.content ?? '').includes('AIRINGCAL_IMAGE_BASE_URL'), `pulled .env must not contain a stale image base: ${unsetFake.state.distEnvAtDeploy.content}`)
  assert.equal(existsSync(unsetFake.state.distEnvAtDeploy.envFile), false)

  const setFake = createFakeEdgeone()
  const setRes = await (await makeEdgeoneIo(setFake, { imageBaseUrl: 'https://img.example.test' })).deployEdgeoneOverseas()
  assert.equal(setRes.imageBaseUrlPersisted, true)
  assert.ok(!setFake.log.some((l) => l.includes('env rm AIRINGCAL_IMAGE_BASE_URL')))
  assert.match(String(setFake.state.distEnvAtDeploy.content ?? ''), /AIRINGCAL_IMAGE_BASE_URL=https:\/\/img\.example\.test/)
})

test('deployEdgeoneOverseas fails closed when the pulled .env is missing a required key (no deploy)', async () => {
  const fake = createFakeEdgeone({ pullOmitKeys: ['AIRINGCAL_PUBLIC_BASE_URL'] })
  const io = await makeEdgeoneIo(fake, { imageBaseUrl: 'https://img.example.test' })
  await assert.rejects(io.deployEdgeoneOverseas(), /AIRINGCAL_PUBLIC_BASE_URL|refusing|missing/i)
  assert.equal(fake.state.deployCalls, 0, 'must not deploy when the bundled .env is incomplete')
  assert.ok(fake.state.pullTarget && !existsSync(fake.state.pullTarget), 'dist/.env must be cleaned up on failure')
  assert.ok(fake.state.linkCwd && !existsSync(fake.state.linkCwd), 'linked temp dir must be cleaned on failure')
})


// ---------------------------------------------------------------------------
// netretry: transient Cloudflare network failures must be retried (bounded)
// and never misclassified as missing scopes.
// ---------------------------------------------------------------------------

const TRANSIENT_NOTE_RE = /transient Cloudflare network failure \(retried; re-run apply if it persists\)/

test('withNetworkRetry retries retriable failures then succeeds (sleeps 500 then 2000)', async () => {
  const sleeps = []
  let calls = 0
  const result = await withNetworkRetry(
    async () => {
      calls += 1
      if (calls < 3) {
        const err = new TypeError('fetch failed')
        throw err
      }
      return 'ok'
    },
    {
      isRetriable: (error) => error instanceof TypeError,
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    },
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [500, 2000])
})

test('withNetworkRetry rethrows non-retriable errors immediately (1 attempt, no sleep)', async () => {
  let calls = 0
  await assert.rejects(
    withNetworkRetry(
      async () => {
        calls += 1
        const err = new Error('403 Forbidden')
        err.status = 403
        throw err
      },
      {
        isRetriable: () => false,
        sleep: () => {
          throw new Error('must not sleep for non-retriable errors')
        },
      },
    ),
    /403 Forbidden/,
  )
  assert.equal(calls, 1)
})

test('withNetworkRetry backoff is bounded at the last delay', async () => {
  const sleeps = []
  let calls = 0
  await assert.rejects(
    withNetworkRetry(
      async () => {
        calls += 1
        throw new Error('fetch failed')
      },
      {
        attempts: 4,
        isRetriable: (error) => /fetch failed/.test(error.message),
        sleep: (ms) => {
          sleeps.push(ms)
          return Promise.resolve()
        },
      },
    ),
    /fetch failed/,
  )
  assert.equal(calls, 4)
  assert.deepEqual(sleeps, [500, 2000, 2000])
})

test('cfApi retries transient fetch throws and succeeds on the third call', async () => {
  const sleeps = []
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls < 3) throw new TypeError('fetch failed')
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, result: { id: 'ACCOUNT_TOKEN_ID' } }
      },
    }
  }
  const body = await cfApi(fetchImpl, 'tok', '/user/tokens/verify', {}, {
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  })
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [500, 2000])
  assert.equal(body.result.id, 'ACCOUNT_TOKEN_ID')
})

test('cfApi does not retry 403 auth/business failures', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return {
      ok: false,
      status: 403,
      async json() {
        return { success: false, errors: [{ code: 9106, message: 'Invalid API Token scopes' }] }
      },
    }
  }
  await assert.rejects(
    cfApi(fetchImpl, 'tok', '/user/tokens/verify', {}, { sleep: () => { throw new Error('must not sleep') } }),
    /9106.*Invalid API Token scopes/,
  )
  assert.equal(calls, 1)
})

test('cfApi does not retry 404 responses', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: false, status: 404, async json() { return { success: false, errors: [] } } }
  }
  await assert.rejects(
    cfApi(fetchImpl, 'tok', '/zones/z/rulesets/phases/p/entrypoint', {}, { sleep: async () => {} }),
    /404/,
  )
  assert.equal(calls, 1)
})

test('cfApi retries 429/5xx HTTP statuses', async () => {
  const statuses = [429, 503]
  let calls = 0
  const fetchImpl = async () => {
    const status = statuses[calls]
    calls += 1
    if (status) {
      return { ok: false, status, async json() { return { success: false, errors: [] } } }
    }
    return { ok: true, status: 200, async json() { return { success: true, result: 'done' } } }
  }
  const body = await cfApi(fetchImpl, 'tok', '/zones/z', {}, { sleep: async () => {} })
  assert.equal(calls, 3)
  assert.equal(body.result, 'done')
})

test('runWrangler retries network-ish spawn failures and succeeds', async () => {
  const calls = []
  const sleeps = []
  const result = await runWrangler(
    (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (calls.length === 1) {
        return { status: 1, stdout: '', stderr: 'fetch failed', error: null }
      }
      return { status: 0, stdout: '[{"name":"airingcal-development"}]', stderr: '', error: null }
    },
    ['r2', 'bucket', 'list'],
    { AIRINGCAL_CLOUDFLARE_API_TOKEN: 'tok' },
    {
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    },
  )
  assert.equal(result.status, 0)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [1000])
})

test('runWrangler does not retry real permission failures', async () => {
  let calls = 0
  await assert.rejects(
    runWrangler(
      () => {
        calls += 1
        return { status: 1, stdout: '', stderr: 'not enough permissions to list buckets', error: null }
      },
      ['r2', 'bucket', 'list'],
      {},
      {
        sleep: () => {
          throw new Error('must not sleep for permission failures')
        },
      },
    ),
    /not enough permissions/,
  )
  assert.equal(calls, 1)
})

test('runGh retries network-ish spawn failures (sleeps 1000 then 3000)', async () => {
  const calls = []
  const sleeps = []
  const result = await runGh(
    (cmd, args) => {
      calls.push(args.join(' '))
      if (calls.length < 3) {
        return { status: 1, stdout: '', stderr: 'read ECONNRESET', error: null }
      }
      return { status: 0, stdout: '[]', stderr: '', error: null }
    },
    ['run', 'list', '--repo', 'x/y', '--json', 'databaseId'],
    {},
    {
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    },
  )
  assert.equal(result.status, 0)
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [1000, 3000])
})

test('runGh retries GitHub API EOF failures', async () => {
  const calls = []
  const result = await runGh(
    (cmd, args) => {
      calls.push(args.join(' '))
      if (calls.length < 3) {
        return {
          status: 1,
          stdout: '',
          stderr: 'failed to get secrets: Get "https://api.github.com/repos/x/y/environments/development/secrets?per_page=100": EOF',
          error: null,
        }
      }
      return { status: 0, stdout: '[]', stderr: '', error: null }
    },
    ['secret', 'list', '--env', 'development', '--repo', 'x/y'],
    {},
    { sleep: () => Promise.resolve() },
  )
  assert.equal(result.status, 0)
  assert.equal(calls.length, 3)
})

test('probeToken reports transient network failure instead of a missing-scope claim', async () => {
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
      const joined = args.join(' ')
      calls.push(joined)
      return {
        status: 1,
        stdout: '',
        stderr: joined.includes('whoami') ? 'connection reset by peer' : 'fetch failed',
        error: null,
      }
    },
    sleepImpl: async () => {},
    fetchImpl: async () => {
      throw new Error('fetch must not be used by probeToken')
    },
  })
  const result = await io.probeToken({})
  assert.equal(result.ok, false)
  assert.ok(
    result.missingScopes.some((s) => TRANSIENT_NOTE_RE.test(s)),
    `expected transient network note, got ${JSON.stringify(result.missingScopes)}`,
  )
  assert.ok(
    result.missingScopes.every((s) => TRANSIENT_NOTE_RE.test(s)),
    `no scopes claim allowed for pure network failure, got ${JSON.stringify(result.missingScopes)}`,
  )
  // Both probes retried (initial + 2 retries) and still failed → fail-closed.
  assert.equal(calls.filter((c) => c.includes('whoami')).length, 3)
  assert.equal(calls.filter((c) => c.includes('r2 bucket list')).length, 3)
})

test('probeToken keeps real permission failures labeled as scopes', async () => {
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
    spawnSyncImpl: (cmd, args) => ({
      status: 1,
      stdout: '',
      stderr: args.join(' ').includes('whoami') ? 'Unauthorized: not authenticated' : 'fetch failed',
      error: null,
    }),
    sleepImpl: async () => {},
    fetchImpl: async () => ({ status: 403 }),
  })
  const result = await io.probeToken({})
  assert.equal(result.ok, false)
  assert.ok(
    result.missingScopes.some((s) => /Cloudflare API token authentication/.test(s)),
    JSON.stringify(result.missingScopes),
  )
  assert.ok(result.missingScopes.some((s) => TRANSIENT_NOTE_RE.test(s)))
})

test('probeAnonymousAccess retries a transient fetch failure and records definitive statuses', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  const queue = [
    () => {
      const err = new Error('connect ECONNRESET 104.16.0.1:443')
      err.errno = 'ECONNRESET'
      err.code = 'ECONNRESET'
      throw err
    },
    () => ({ status: 403 }),
    () => ({ status: 404 }),
  ]
  let calls = 0
  const io = createLiveDevelopmentApplyIo({
    env: {},
    plan,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      const step = queue[Math.min(calls, queue.length - 1)]
      calls += 1
      return step()
    },
  })
  const result = await io.probeAnonymousAccess({})
  assert.equal(calls, 3)
  assert.deepEqual(
    result.probes.map((p) => p.status),
    [403, 404],
  )
})

test('probeAnonymousAccess does not retry definitive HTTP statuses', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  let calls = 0
  const io = createLiveDevelopmentApplyIo({
    env: {},
    plan,
    sleepImpl: async () => {
      throw new Error('must not sleep for definitive statuses')
    },
    fetchImpl: async () => {
      calls += 1
      return { status: 200 }
    },
  })
  const result = await io.probeAnonymousAccess({})
  assert.equal(calls, 2)
  assert.deepEqual(
    result.probes.map((p) => p.status),
    [200, 200],
  )
})

test('probeAnonymousAccess still fails closed when the network never recovers', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({
    target: 'cloudflare',
    publicBaseUrl: 'https://dev-cdn.example.test',
    mode: 'apply',
  })
  let calls = 0
  const io = createLiveDevelopmentApplyIo({
    env: {},
    plan,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1
      throw new TypeError('fetch failed')
    },
  })
  await assert.rejects(io.probeAnonymousAccess({}), /fetch failed/)
  assert.equal(calls, 3)
})

test('verifyImageRouting retries transient pointer fetch failures', async () => {
  const calls = []
  let pointerAttempts = 0
  const inner = routingFetchDouble({
    location: `https://dev-cdn.example.test/images/${ROUTE_HASH}/original`,
    calls,
  })
  const io = await buildRoutingIo(async (url, init) => {
    if (String(url).endsWith('/public/current-release.json')) pointerAttempts += 1
    if (String(url).endsWith('/public/current-release.json') && pointerAttempts === 1) {
      throw new TypeError('fetch failed')
    }
    return inner(url, init)
  })
  const receipt = await io.verifyImageRouting(routingCtx())
  assert.equal(receipt.hash, ROUTE_HASH)
  assert.equal(pointerAttempts, 2, 'pointer retried once after transient failure')
  const pointerCalls = calls.filter(([u]) => u.endsWith('/public/current-release.json'))
  assert.equal(pointerCalls.length, 1, 'definitive statuses are never retried')
})

// --- copyPrefixes: bounded-concurrency copy (round 16 timeout fix) ---

/** Deterministic injected object-store doubles; no real S3 / no new deps. */
function makeCopyDoubles(opts = {}) {
  const {
    keys = [],
    preexisting = new Set(),
    failPutKey = null,
    delayMs = 0,
    missingHeadKeys = new Set(),
    missingBodyKeys = new Set(),
    objContentType = 'image/jpeg',
    headContentType = 'image/png',
  } = opts
  const puts = []
  const closes = []
  let inflight = 0
  let maxInflight = 0
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
  const createObjectStore = (config) => {
    const isDest = config.bucket === 'dest-bucket'
    return {
      async list(prefix) {
        return keys.filter((k) => k.startsWith(prefix))
      },
      async head(key) {
        if (isDest) {
          return preexisting.has(key)
            ? { etag: 'W/"same"', size: 4, contentType: headContentType }
            : null
        }
        if (missingHeadKeys.has(key)) return null
        return { etag: 'same', size: 4, contentType: headContentType }
      },
      async get(key) {
        if (missingBodyKeys.has(key)) return null
        return {
          body: new Uint8Array([1, 2, 3, 4]),
          etag: 'same',
          contentType: objContentType,
        }
      },
      async put(key, body, options) {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        try {
          await sleep(delayMs)
          if (failPutKey !== null && key === failPutKey) {
            throw new Error(`S3 put failed for ${key}`)
          }
          puts.push({ key, contentType: options?.contentType })
          return { etag: 'new' }
        } finally {
          inflight -= 1
        }
      },
      close() {
        closes.push(config.bucket)
      },
    }
  }
  return { createObjectStore, puts, closes, maxInflight: () => maxInflight }
}

function sampleKeys(count) {
  return Array.from({ length: count }, (_, i) => `images/hash${String(i).padStart(2, '0')}/original`)
}

function copyArgs(doubles, extra = {}) {
  return {
    createObjectStore: doubles.createObjectStore,
    s3Creds: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    sourceBucket: 'source-bucket',
    destBucket: 'dest-bucket',
    prefixes: ['images/'],
    write: () => {},
    ...extra,
  }
}

test('copyPrefixes copies each key once with bounded concurrency 2', async () => {
  const keys = sampleKeys(20)
  const doubles = makeCopyDoubles({ keys })
  const result = await copyPrefixes(copyArgs(doubles, { concurrency: 2 }))
  assert.equal(result.copied, 20)
  assert.equal(result.skipped, 0)
  assert.equal(result.sourceBucket, 'source-bucket')
  assert.equal(result.destBucket, 'dest-bucket')
  assert.deepEqual(result.prefixes, ['images/'])
  assert.equal(doubles.puts.length, 20, 'one put per key')
  assert.equal(new Set(doubles.puts.map((p) => p.key)).size, 20, 'no duplicate puts')
  assert.ok(doubles.puts.every((p) => p.contentType === 'image/jpeg'), 'contentType preserved')
  assert.deepEqual([...doubles.closes].sort(), ['dest-bucket', 'source-bucket'])
})

test('copyPrefixes bounds in-flight puts by the concurrency limit', async () => {
  const keys = sampleKeys(20)
  const doubles = makeCopyDoubles({ keys, delayMs: 5 })
  await copyPrefixes(copyArgs(doubles, { concurrency: 2 }))
  assert.ok(doubles.maxInflight() > 1, 'puts overlap (concurrent)')
  assert.ok(doubles.maxInflight() <= 2, 'never exceeds concurrency 2')
})

test('copyPrefixes defaults to bounded concurrency 8', async () => {
  const keys = sampleKeys(20)
  const doubles = makeCopyDoubles({ keys, delayMs: 5 })
  const result = await copyPrefixes(copyArgs(doubles))
  assert.equal(result.copied, 20)
  assert.ok(doubles.maxInflight() > 1, 'puts overlap (concurrent)')
  assert.ok(doubles.maxInflight() <= 8, 'never exceeds default concurrency 8')
})

test('copyPrefixes flattens prefixes and skips identical dest (size + loose etag)', async () => {
  const keys = [
    ...sampleKeys(10),
    ...Array.from({ length: 10 }, (_, i) => `public/item${i}.json`),
  ]
  const preexisting = new Set([keys[2], keys[5], 'public/item3.json'])
  const doubles = makeCopyDoubles({ keys, preexisting })
  const result = await copyPrefixes(
    copyArgs(doubles, { prefixes: ['images/', 'public/'], concurrency: 3 }),
  )
  assert.equal(result.copied, 17)
  assert.equal(result.skipped, 3)
  assert.equal(doubles.puts.length, 17)
  assert.ok(!doubles.puts.some((p) => preexisting.has(p.key)))
})

test('copyPrefixes skips trailing-slash keys, missing heads, and missing bodies', async () => {
  const keys = [
    'images/a/original',
    'images/dir/',
    'images/missing-head/original',
    'images/missing-body/original',
  ]
  const doubles = makeCopyDoubles({
    keys,
    missingHeadKeys: new Set(['images/missing-head/original']),
    missingBodyKeys: new Set(['images/missing-body/original']),
  })
  const result = await copyPrefixes(copyArgs(doubles, { concurrency: 2 }))
  assert.equal(result.copied, 1)
  assert.equal(result.skipped, 0)
  assert.deepEqual(doubles.puts.map((p) => p.key), ['images/a/original'])
})

test('copyPrefixes falls back to srcHead.contentType when body has none', async () => {
  const doubles = makeCopyDoubles({ keys: ['images/a/original'], objContentType: null })
  await copyPrefixes(copyArgs(doubles, { concurrency: 2 }))
  assert.equal(doubles.puts.length, 1)
  assert.equal(doubles.puts[0].contentType, 'image/png')
})

test('copyPrefixes rejects on any per-key put error and still closes both stores', async () => {
  const keys = sampleKeys(20)
  const doubles = makeCopyDoubles({ keys, failPutKey: keys[7], delayMs: 2 })
  await assert.rejects(
    copyPrefixes(copyArgs(doubles, { concurrency: 2 })),
    /S3 put failed for images\/hash07\/original/,
  )
  assert.deepEqual([...doubles.closes].sort(), ['dest-bucket', 'source-bucket'])
})

test('copyPrefixes emits a progress line at every interval boundary', async () => {
  const keys = sampleKeys(20)
  const doubles = makeCopyDoubles({ keys })
  const lines = []
  await copyPrefixes(
    copyArgs(doubles, {
      concurrency: 2,
      progressInterval: 5,
      write: (line) => lines.push(line),
    }),
  )
  assert.equal(lines.length, 4)
  const parsed = lines.map((line) => {
    const m = line.match(/^\[deploy-env\] copy ([^:]+): (\d+)\/(\d+) \(copied=(\d+), skipped=(\d+)\)$/)
    assert.ok(m, `progress line format: ${line}`)
    assert.equal(m[1], 'source-bucket')
    assert.equal(Number(m[3]), 20)
    assert.ok(!line.includes('images/hash') && !line.includes('AK') && !line.includes('SK'))
    return Number(m[2])
  })
  assert.deepEqual(parsed, [5, 10, 15, 20])
})

test('formatCopyProgress renders the documented shape without leaking keys or secrets', () => {
  assert.equal(
    formatCopyProgress({
      sourceBucket: 'airingcal-staging-public',
      done: 100,
      total: 2029,
      copied: 90,
      skipped: 10,
    }),
    '[deploy-env] copy airingcal-staging-public: 100/2029 (copied=90, skipped=10)',
  )
})

test('syncGithubEnvironment derives USERS_JSON from the staging Environment when .env omits it', async () => {
  const { createLiveDevelopmentApplyIo } = await import('./deploy-env.mjs')
  const plan = buildDevelopmentDeployPlan({ target: 'cloudflare', publicBaseUrl: 'https://dev.example.test', mode: 'apply' })
  const calls = []
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args])
    const joined = args.join(' ')
    if (joined.includes('environments/staging/variables/AIRINGCAL_STAGING_USERS_JSON')) {
      return { status: 0, stdout: '[{"userId":"821993","username":"821993"}]\n', stderr: '', error: null }
    }
    if (joined.startsWith('secret list')) {
      return { status: 0, stdout: '[]', stderr: '', error: null }
    }
    return { status: 0, stdout: '', stderr: '', error: null }
  }
  const io = createLiveDevelopmentApplyIo({
    env: {
      AIRINGCAL_PRIMARY_USER_ID: '821993',
      AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: 'f082535090d97b0927e4ed69c9a56685',
      AIRINGCAL_CLOUDFLARE_API_TOKEN: 'cfut_test-token',
      AIRINGCAL_BANGUMI_TOKEN: 'bgm-test-token',
    },
    plan,
    spawnSyncImpl: spawn,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ success: true, result: { id: 'test-access-key-id' }, errors: [] }),
    }),
    createObjectStore: () => ({
      list: async () => [],
      head: async () => ({ etag: 'x', size: 1, contentType: 'text/plain' }),
      close: () => {},
    }),
  })
  await io.deriveAndVerifyS3({})
  const result = await io.syncGithubEnvironment({})
  assert.ok(result.variablesSynced.includes('AIRINGCAL_DEVELOPMENT_USERS_JSON'))
  const setCall = calls.find((c) => c[0] === 'gh' && c[1] === 'variable' && c[2] === 'set' && c[3] === 'AIRINGCAL_DEVELOPMENT_USERS_JSON')
  assert.ok(setCall, 'USERS_JSON must be synced to development')
  assert.equal(setCall[setCall.length - 1], '[{"userId":"821993","username":"821993"}]')
})
