import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./materialize-v3-read-staging-config.mjs', import.meta.url))
const REPO_SOURCE = fileURLToPath(new URL('../apps/v3-read-worker/wrangler.toml', import.meta.url))
const GIT_SHA = 'a'.repeat(40)

function run(args, env) {
  return execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function expectFailure(args, env, pattern) {
  assert.throws(
    () => execFileSync(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: 'pipe',
    }),
    (error) => {
      assert.match(String(error.stderr), pattern)
      return true
    },
  )
}

const VALID_ENV = {
  AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: 'airing-cal-public-staging',
  AIRINGCAL_STAGING_PUBLIC_BASE_URL: 'https://staging-cdn.example.com',
  BANGUMI_GIT_COMMIT_SHA: GIT_SHA,
}

test('staging config materializer rewrites the release bucket, main and vars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-v3-staging-'))
  const source = join(dir, 'apps', 'v3-read-worker', 'wrangler.toml')
  const target = join(dir, 'runner-temp', 'wrangler-v3-read-staging.toml')
  mkdirSync(dirname(source), { recursive: true })
  writeFileSync(source, readFileSync(REPO_SOURCE, 'utf8'))

  run([source, target], VALID_ENV)

  const materialized = readFileSync(target, 'utf8')
  assert.match(materialized, /bucket_name = "airing-cal-public-staging"/)
  assert.doesNotMatch(materialized, /bucket_name = "airing-cal-public"\n/)
  assert.match(materialized, /main = "\.\.\/apps\/v3-read-worker\/src\/index\.ts"/)
  assert.match(materialized, /\[vars\]\nAIRINGCAL_PUBLIC_BASE_URL = "https:\/\/staging-cdn\.example\.com"\n/)
  assert.match(materialized, new RegExp(`BANGUMI_GIT_COMMIT_SHA = "${GIT_SHA}"`))
  assert.doesNotMatch(materialized, /PACKAGE_VERSION/, 'package version is optional')
})

test('staging config materializer honours an explicit PACKAGE_VERSION', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-v3-staging-'))
  const source = join(dir, 'wrangler.toml')
  const target = join(dir, 'out', 'wrangler.toml')
  writeFileSync(source, readFileSync(REPO_SOURCE, 'utf8'))

  run([source, target], { ...VALID_ENV, PACKAGE_VERSION: '0.2.0-staging.1' })
  assert.match(readFileSync(target, 'utf8'), /PACKAGE_VERSION = "0\.2\.0-staging\.1"/)
})

test('staging config materializer refuses production or invalid values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-v3-staging-'))
  const source = join(dir, 'wrangler.toml')
  const target = join(dir, 'out', 'wrangler.toml')
  writeFileSync(source, readFileSync(REPO_SOURCE, 'utf8'))

  expectFailure([source, target], { ...VALID_ENV, AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: '' }, /BUCKET is required/)
  expectFailure(
    [source, target],
    { ...VALID_ENV, AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: 'airing-cal-public' },
    /must differ from the production bucket/,
  )
  expectFailure(
    [source, target],
    { ...VALID_ENV, AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: 'Bad_Bucket' },
    /valid R2 bucket name/,
  )
  expectFailure(
    [source, target],
    { ...VALID_ENV, AIRINGCAL_STAGING_PUBLIC_BASE_URL: 'https://PLACEHOLDER_PUBLIC_CDN' },
    /placeholder value/,
  )
  expectFailure(
    [source, target],
    { ...VALID_ENV, AIRINGCAL_STAGING_PUBLIC_BASE_URL: 'http://staging-cdn.example.com' },
    /absolute https URL/,
  )
  expectFailure(
    [source, target],
    { ...VALID_ENV, AIRINGCAL_STAGING_PUBLIC_BASE_URL: 'https://staging-cdn.example.com/?token=1' },
    /without query or fragment/,
  )
  expectFailure([source, target], { ...VALID_ENV, BANGUMI_GIT_COMMIT_SHA: 'abc' }, /40 character git sha/)
})

test('staging config materializer rejects sources that already declare vars or envs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-v3-staging-'))
  const target = join(dir, 'out', 'wrangler.toml')

  const withVars = join(dir, 'with-vars.toml')
  writeFileSync(withVars, 'name = "x"\nmain = "src/index.ts"\n[vars]\nFOO = "bar"\n')
  expectFailure([withVars, target], VALID_ENV, /must not declare \[vars\]/)

  const withEnv = join(dir, 'with-env.toml')
  writeFileSync(withEnv, 'name = "x"\nmain = "src/index.ts"\n[env.staging]\nname = "y"\n')
  expectFailure([withEnv, target], VALID_ENV, /must not declare \[env\./)
})
