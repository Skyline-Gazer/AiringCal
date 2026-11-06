import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildUsersJson,
  deriveStagingConfig,
  parseWranglerDevUrlOutput,
  parseWranglerWhoamiJson,
  redactSecrets,
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

test('buildUsersJson auto-generates valid users array from PRIMARY_USER_ID when omitted', () => {
  const json = buildUsersJson({ primaryUserId: '857123' })
  assert.deepEqual(JSON.parse(json), [{ userId: '857123', username: '857123' }])

  const withUsername = buildUsersJson({ primaryUserId: '857123', username: 'kooling' })
  assert.deepEqual(JSON.parse(withUsername), [{ userId: '857123', username: 'kooling' }])
})

test('buildUsersJson normalizes explicit JSON and rejects missing primaryUserId', () => {
  const normalized = buildUsersJson({
    primaryUserId: '857123',
    usersJson: JSON.stringify([{ id: '857123', username: 'owner' }]),
  })
  assert.deepEqual(JSON.parse(normalized), [{ userId: '857123', username: 'owner' }])

  assert.throws(
    () =>
      buildUsersJson({
        primaryUserId: '999',
        usersJson: JSON.stringify([{ userId: '857123', username: 'owner' }]),
      }),
    /must contain an entry matching AIRINGCAL_STAGING_PRIMARY_USER_ID/,
  )
})

test('deriveStagingConfig derives S3 endpoint, region, buckets, worker name and never leaks secrets', () => {
  const result = deriveStagingConfig(BASE_ENV)
  assert.equal(result.repository, 'Skyline-Gazer/AiringCal')
  assert.equal(result.environment, 'staging')
  assert.deepEqual(result.variables, {
    AIRINGCAL_STAGING_PRIMARY_USER_ID: '857123',
    AIRINGCAL_STAGING_USERS_JSON: '[{"userId":"857123","username":"857123"}]',
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
  assert.equal(Object.keys(result.secretsConfigured).length, 3)
  assert.deepEqual(Object.keys(result.secretsConfigured), [...STAGING_SECRET_KEYS])

  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /secret-bangumi-token-value/)
  assert.doesNotMatch(serialized, /secret-s3-access-key-id/)
  assert.doesNotMatch(serialized, /secret-s3-secret-access-key/)
})

test('deriveStagingConfig enforces cross-repository and cross-environment isolation', () => {
  assert.throws(
    () => deriveStagingConfig({ ...BASE_ENV, AIRINGCAL_REPOSITORY: 'Skyline-Gazer/OtherRepo' }),
    /Cross-repository guard/,
  )
  assert.throws(
    () => deriveStagingConfig({ ...BASE_ENV, AIRINGCAL_TARGET_ENVIRONMENT: 'production' }),
    /Cross-environment guard/,
  )
  for (const prodBucket of [
    'airing-cal-public',
    'airing-cal-images',
    'airing-cal-data',
    'airing-cal-checkpoint',
  ]) {
    assert.throws(
      () =>
        deriveStagingConfig({
          ...BASE_ENV,
          AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: prodBucket,
        }),
      /must never use production bucket/,
    )
    assert.throws(
      () =>
        deriveStagingConfig({
          ...BASE_ENV,
          AIRINGCAL_STAGING_CHECKPOINT_R2_BUCKET: prodBucket,
        }),
      /must never use production bucket/,
    )
  }
  assert.throws(
    () =>
      deriveStagingConfig({
        ...BASE_ENV,
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
    'Public access is enabled at https://pub-9876543210fedcba.r2.dev.',
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

test('setup-staging.sh --dry-run is idempotent and never leaks secret values', () => {
  const runOnce = () =>
    spawnSync('bash', [SCRIPT, '--dry-run', '--primary-user-id', '857123'], {
      cwd: ROOT,
      env: { ...process.env, ...BASE_ENV },
      encoding: 'utf8',
    })

  const first = runOnce()
  const second = runOnce()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout, second.stdout)

  const combined = `${first.stdout}\n${first.stderr}`
  assert.doesNotMatch(combined, /secret-bangumi-token-value/)
  assert.doesNotMatch(combined, /secret-s3-access-key-id/)
  assert.doesNotMatch(combined, /secret-s3-secret-access-key/)
})
