import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readSyncUserConfig } from '../apps/node-jobs/src/sync/config.ts'
import {
  assertCheckpointBucketPrivate,
  classifyStagingWorkerHealth,
  deriveStagingConfig,
  loadDotEnvFile,
  parseDotEnvContent,
  parseWranglerDevUrlOutput,
  parseWranglerWhoamiJson,
  redactSecrets,
  resolveBangumiUser,
  resolveUsersConfig,
  STAGING_DEFAULTS,
  STAGING_SECRET_KEYS,
} from './setup-staging-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = resolve(ROOT, 'scripts', 'setup-staging.sh')

const BASE_ENV = {
  AIRINGCAL_STAGING_PRIMARY_USER_ID: '857123',
  AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  AIRINGCAL_STAGING_PUBLIC_BASE_URL: 'https://pub-1234567890abcdef.r2.dev',
  AIRINGCAL_STAGING_BANGUMI_TOKEN: 'secret-bangumi-token-value',
  AIRINGCAL_STAGING_S3_ACCESS_KEY_ID: 'secret-s3-access-key-id',
  AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY: 'secret-s3-secret-access-key',
}

function mockBgmFetch(routes) {
  return async (url, init) => {
    const u = new URL(url)
    const handler = routes[u.pathname]
    if (!handler) {
      return new Response(JSON.stringify({ title: 'Not Found' }), { status: 404 })
    }
    return handler(u, init)
  }
}

test('parseDotEnvContent safely parses quotes, spaces, comments and injection-like strings as pure data', () => {
  const raw = [
    '# Comment line',
    'export AIRINGCAL_STAGING_PRIMARY_USER_ID=857123 # inline comment',
    'AIRINGCAL_STAGING_BANGUMI_TOKEN="tok_with spaces & $(echo pwned) `id` \\"quote\\""',
    "AIRINGCAL_STAGING_S3_ACCESS_KEY_ID='single_quoted_$(whoami)_#not_a_comment'",
    'AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY=plain_value_with_#hash_no_space',
    'EMPTY_KEY=',
  ].join('\n')

  const parsed = parseDotEnvContent(raw)
  assert.equal(parsed.AIRINGCAL_STAGING_PRIMARY_USER_ID, '857123')
  assert.equal(
    parsed.AIRINGCAL_STAGING_BANGUMI_TOKEN,
    'tok_with spaces & $(echo pwned) `id` "quote"',
  )
  assert.equal(
    parsed.AIRINGCAL_STAGING_S3_ACCESS_KEY_ID,
    'single_quoted_$(whoami)_#not_a_comment',
  )
  assert.equal(
    parsed.AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY,
    'plain_value_with_#hash_no_space',
  )
  assert.equal(parsed.EMPTY_KEY, '')
})

test('loadDotEnvFile reads .env without modifying the file or overwriting non-empty existing env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-dotenv-test-'))
  try {
    const dotenvPath = join(dir, '.env')
    const originalContent = [
      'AIRINGCAL_STAGING_PRIMARY_USER_ID=857123',
      'AIRINGCAL_STAGING_BANGUMI_TOKEN=from-dotenv-secret',
      'AIRINGCAL_STAGING_USERS_JSON=',
    ].join('\n')
    writeFileSync(dotenvPath, originalContent, 'utf8')

    const merged = loadDotEnvFile(dotenvPath, {
      AIRINGCAL_STAGING_PRIMARY_USER_ID: 'override-id',
      AIRINGCAL_STAGING_USERS_JSON: '[{"userId":"override-id","username":"u"}]',
    })
    assert.equal(merged.AIRINGCAL_STAGING_PRIMARY_USER_ID, 'override-id')
    assert.equal(merged.AIRINGCAL_STAGING_BANGUMI_TOKEN, 'from-dotenv-secret')
    assert.equal(merged.AIRINGCAL_STAGING_USERS_JSON, '[{"userId":"override-id","username":"u"}]')
    assert.equal(readFileSync(dotenvPath, 'utf8'), originalContent)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveUsersConfig queries Bangumi API /v0/users/{username} and satisfies node-jobs contract', async () => {
  const fetchImpl = mockBgmFetch({
    '/v0/users/857123': (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer bgm-secret-tok')
      assert.match(init.headers['User-Agent'], /AiringCal/)
      return new Response(
        JSON.stringify({
          id: 857123,
          username: 'real_bgm_slug',
          nickname: 'Kooling',
          user_group: 10,
          avatar: {},
          sign: '',
        }),
        { status: 200 },
      )
    },
  })

  const resolved = await resolveUsersConfig({
    primaryUserId: '857123',
    bangumiToken: 'bgm-secret-tok',
    fetchImpl,
  })
  assert.equal(resolved.primaryUserId, '857123')
  assert.deepEqual(resolved.users, [{ userId: '857123', username: 'real_bgm_slug' }])

  // Verify compatibility with node-jobs readSyncUserConfig
  const syncCfg = readSyncUserConfig({
    AIRINGCAL_USERS_JSON: resolved.usersJson,
    AIRINGCAL_PRIMARY_USER_ID: resolved.primaryUserId,
    BANGUMI_GIT_COMMIT_SHA: 'a'.repeat(40),
  })
  assert.deepEqual(syncCfg.users, [{ userId: '857123', username: 'real_bgm_slug' }])
  assert.equal(syncCfg.primaryUserId, '857123')
})

test('resolveBangumiUser falls back to /v0/me when /v0/users/{uid} returns 404 after custom username change', async () => {
  const fetchImpl = mockBgmFetch({
    '/v0/users/857123': () => new Response(JSON.stringify({ title: 'Not Found' }), { status: 404 }),
    '/v0/me': () =>
      new Response(
        JSON.stringify({
          id: 857123,
          username: 'custom_slug',
          nickname: 'Owner',
          user_group: 10,
          avatar: {},
          sign: '',
          email: 'a@b.c',
          reg_time: '2020-01-01T00:00:00Z',
        }),
        { status: 200 },
      ),
  })

  const user = await resolveBangumiUser({
    primaryUserId: '857123',
    bangumiToken: 'bgm-secret-tok',
    fetchImpl,
  })
  assert.equal(user.userId, '857123')
  assert.equal(user.username, 'custom_slug')
})

test('resolveUsersConfig fails closed on Bangumi API error instead of guessing username = primaryUserId', async () => {
  const fetchImpl = mockBgmFetch({
    '/v0/users/857123': () => new Response('upstream error', { status: 502 }),
  })

  await assert.rejects(
    () =>
      resolveUsersConfig({
        primaryUserId: '857123',
        bangumiToken: 'secret-tok-xyz',
        fetchImpl,
      }),
    /Bangumi API failed to resolve user "857123" \(HTTP 502/,
  )
})

test('resolveUsersConfig honours explicit --username and --users-json overrides', async () => {
  const byUsername = await resolveUsersConfig({
    primaryUserId: '857123',
    username: 'explicit_user',
    fetchImpl: () => {
      throw new Error('must not call network when username override is given')
    },
  })
  assert.equal(byUsername.usersJson, '[{"userId":"857123","username":"explicit_user"}]')

  const byJson = await resolveUsersConfig({
    primaryUserId: '857123',
    usersJson: '[{"userId":"857123","username":"json_user"}]',
    fetchImpl: () => {
      throw new Error('must not call network when usersJson override is given')
    },
  })
  assert.equal(byJson.usersJson, '[{"userId":"857123","username":"json_user"}]')
})

test('assertCheckpointBucketPrivate enforces disabled r2.dev access on checkpoint bucket', () => {
  assert.equal(
    assertCheckpointBucketPrivate('Public access via the r2.dev URL is disabled.'),
    true,
  )
  assert.throws(
    () =>
      assertCheckpointBucketPrivate(
        "Public access is enabled at 'https://pub-123456.r2.dev'.",
      ),
    /Security violation: checkpoint bucket/,
  )
  assert.throws(
    () => assertCheckpointBucketPrivate('unexpected wrangler output'),
    /Could not confirm that checkpoint bucket/,
  )
})

test('classifyStagingWorkerHealth distinguishes 503 NO_RELEASE from 200 ready and rejects other errors', () => {
  const uninit = classifyStagingWorkerHealth(
    503,
    JSON.stringify({ ok: false, worker: 'portable-read', error: { code: 'NO_RELEASE' } }),
  )
  assert.equal(uninit.state, 'uninitialized_no_release')
  assert.equal(uninit.readerAcceptance, 'not_initialized')

  const ready = classifyStagingWorkerHealth(
    200,
    JSON.stringify({ ok: true, data: { publish: { generation: 2 } } }),
  )
  assert.equal(ready.state, 'ready')
  assert.equal(ready.generation, 2)
  assert.equal(ready.readerAcceptance, 'pass')

  assert.throws(
    () =>
      classifyStagingWorkerHealth(
        503,
        JSON.stringify({ ok: false, error: { code: 'NO_PUBLIC_STORE_BINDING' } }),
      ),
    /NO_PUBLIC_STORE_BINDING/,
  )
})

test('deriveStagingConfig derives S3 endpoint, region, buckets, worker name and never leaks secrets', async () => {
  const fetchImpl = mockBgmFetch({
    '/v0/users/857123': () =>
      new Response(
        JSON.stringify({
          id: 857123,
          username: 'kooling_bgm',
          nickname: 'Kooling',
          user_group: 10,
          avatar: {},
          sign: '',
        }),
        { status: 200 },
      ),
  })

  const result = await deriveStagingConfig(BASE_ENV, { fetchImpl })
  assert.equal(result.repository, 'Skyline-Gazer/AiringCal')
  assert.equal(result.environment, 'staging')
  assert.deepEqual(result.variables, {
    AIRINGCAL_STAGING_PRIMARY_USER_ID: '857123',
    AIRINGCAL_STAGING_USERS_JSON: '[{"userId":"857123","username":"kooling_bgm"}]',
    AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    AIRINGCAL_STAGING_PUBLIC_BASE_URL: 'https://pub-1234567890abcdef.r2.dev',
    AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: STAGING_DEFAULTS.publicBucket,
    AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET: STAGING_DEFAULTS.checkpointBucket,
    AIRINGCAL_STAGING_S3_ENDPOINT:
      'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    AIRINGCAL_STAGING_S3_REGION: 'auto',
    AIRINGCAL_STAGING_WORKER_NAME: STAGING_DEFAULTS.workerName,
  })
  assert.deepEqual(result.missingSecrets, [])
  assert.deepEqual(Object.keys(result.secretsConfigured), [...STAGING_SECRET_KEYS])

  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /secret-bangumi-token-value/)
  assert.doesNotMatch(serialized, /secret-s3-access-key-id/)
  assert.doesNotMatch(serialized, /secret-s3-secret-access-key/)
})

test('deriveStagingConfig enforces cross-repository and cross-environment isolation', async () => {
  const envWithUser = { ...BASE_ENV, AIRINGCAL_STAGING_BANGUMI_USERNAME: 'kooling_bgm' }
  await assert.rejects(
    () => deriveStagingConfig({ ...envWithUser, AIRINGCAL_REPOSITORY: 'Skyline-Gazer/OtherRepo' }),
    /Cross-repository guard/,
  )
  await assert.rejects(
    () => deriveStagingConfig({ ...envWithUser, AIRINGCAL_TARGET_ENVIRONMENT: 'production' }),
    /Cross-environment guard/,
  )
  for (const prodBucket of [
    'airing-cal-public',
    'airing-cal-images',
    'airing-cal-data',
    'airing-cal-checkpoint',
  ]) {
    await assert.rejects(
      () =>
        deriveStagingConfig({
          ...envWithUser,
          AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: prodBucket,
        }),
      /must never use production bucket/,
    )
    await assert.rejects(
      () =>
        deriveStagingConfig({
          ...envWithUser,
          AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET: prodBucket,
        }),
      /must never use production bucket/,
    )
  }
  await assert.rejects(
    () =>
      deriveStagingConfig({
        ...envWithUser,
        AIRINGCAL_STAGING_WORKER_NAME: 'airing-cal-frontend',
      }),
    /must never overwrite production worker/,
  )
})

test('parseWranglerWhoamiJson and parseWranglerDevUrlOutput extract non-sensitive values', () => {
  const accountId = parseWranglerWhoamiJson(
    JSON.stringify({
      loggedIn: true,
      accounts: [{ id: 'ABCDEF0123456789ABCDEF0123456789', name: 'Test' }],
    }),
  )
  assert.equal(accountId, 'abcdef0123456789abcdef0123456789')

  const devUrl = parseWranglerDevUrlOutput(
    "Public access is enabled at 'https://pub-9876543210fedcba.r2.dev'.",
  )
  assert.equal(devUrl, 'https://pub-9876543210fedcba.r2.dev')
})

test('redactSecrets scrubs secret values and Bearer tokens', () => {
  const scrubbed = redactSecrets(
    'token=my-secret-123 and Authorization: Bearer super-secret-jwt',
    ['my-secret-123'],
  )
  assert.doesNotMatch(scrubbed, /my-secret-123/)
  assert.doesNotMatch(scrubbed, /super-secret-jwt/)
  assert.match(scrubbed, /\[REDACTED\]/)
})

test('setup-staging.sh --dry-run loads .env file, is idempotent, preserves .env, and never leaks secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-staging-cli-'))
  try {
    const dotenvFile = join(dir, '.env')
    const dotenvContent = [
      'AIRINGCAL_STAGING_PRIMARY_USER_ID=857123',
      'AIRINGCAL_STAGING_BANGUMI_TOKEN="secret-bangumi-token-value-$(echo injection)"',
      'AIRINGCAL_STAGING_S3_ACCESS_KEY_ID=secret-s3-access-key-id',
      'AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY=secret-s3-secret-access-key',
      'AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef',
      'AIRINGCAL_STAGING_PUBLIC_BASE_URL=https://pub-1234567890abcdef.r2.dev',
    ].join('\n')
    writeFileSync(dotenvFile, dotenvContent, 'utf8')

    const runOnce = () =>
      spawnSync(
        'bash',
        [SCRIPT, '--dry-run', '--env-file', dotenvFile, '--username', 'kooling_bgm'],
        {
          cwd: ROOT,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          encoding: 'utf8',
        },
      )

    const first = runOnce()
    const second = runOnce()
    assert.equal(first.status, 0, first.stderr)
    assert.equal(second.status, 0, second.stderr)
    assert.equal(first.stdout, second.stdout)
    assert.equal(readFileSync(dotenvFile, 'utf8'), dotenvContent)

    const combined = `${first.stdout}\n${first.stderr}`
    assert.doesNotMatch(combined, /secret-bangumi-token-value/)
    assert.doesNotMatch(combined, /secret-s3-access-key-id/)
    assert.doesNotMatch(combined, /secret-s3-secret-access-key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
