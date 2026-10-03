import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./materialize-wrangler-config.mjs', import.meta.url))

test('materialize-wrangler-config rewrites migrations_dir relative to the target config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-wrangler-config-'))
  const source = join(dir, 'apps', 'sync-worker', 'wrangler.toml')
  const target = join(dir, 'runner-temp', 'wrangler-sync-worker.toml')

  mkdirSync(join(dir, 'apps', 'sync-worker'), { recursive: true })
  writeFileSync(source, 'migrations_dir = "../../migrations"\n')

  execFileSync(process.execPath, [script, source, target])

  assert.equal(readFileSync(target, 'utf8'), 'migrations_dir = "../migrations"\n')
})

test('materialize-wrangler-config replaces and validates a checked-in D1 placeholder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-wrangler-config-'))
  const source = join(dir, 'wrangler.toml')
  const target = join(dir, 'deploy', 'wrangler.toml')
  const d1DatabaseId = '11111111-1111-4111-8111-111111111111'

  writeFileSync(source, 'd1 = "<AIRING_CAL_D1_DATABASE_ID>"\n')

  assert.throws(
    () => execFileSync(process.execPath, [script, source, target], {
      env: { ...process.env, AIRING_CAL_D1_DATABASE_ID: undefined },
      stdio: 'pipe',
    }),
    /Command failed/,
  )
  assert.throws(
    () => execFileSync(process.execPath, [script, source, target], {
      env: { ...process.env, AIRING_CAL_D1_DATABASE_ID: 'not-a-uuid' },
      stdio: 'pipe',
    }),
    /Command failed/,
  )

  execFileSync(process.execPath, [script, source, target], {
    env: { ...process.env, AIRING_CAL_D1_DATABASE_ID: d1DatabaseId },
  })

  assert.equal(readFileSync(target, 'utf8'), `d1 = "${d1DatabaseId}"\n`)
})

test('materialize-wrangler-config rejects an unresolved D1 placeholder before creating a deploy config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-wrangler-config-'))
  const source = join(dir, 'wrangler.toml')
  const target = join(dir, 'deploy', 'wrangler.toml')

  writeFileSync(source, 'database_id = "<AIRING_CAL_D1_DATABASE_ID>"\n')

  assert.throws(
    () => execFileSync(process.execPath, [script, source, target], {
      env: { ...process.env, AIRING_CAL_D1_DATABASE_ID: '<AIRING_CAL_D1_DATABASE_ID>' },
      stdio: 'pipe',
    }),
    /Command failed/,
  )
  assert.equal(existsSync(target), false, 'dry-run config must not exist while the D1 placeholder is unresolved')
})

test('materialize-wrangler-config injects build vars when provided without a D1 binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-wrangler-config-'))
  const source = join(dir, 'apps', 'frontend-worker', 'wrangler.toml')
  const target = join(dir, 'runner-temp', 'wrangler-frontend-worker.toml')

  mkdirSync(join(dir, 'apps', 'frontend-worker'), { recursive: true })
  writeFileSync(source, 'name = "airing-cal-frontend"\nmain = "src/index.ts"\nkeep_vars = true\n')

  execFileSync(process.execPath, [script, source, target], {
    env: {
      ...process.env,
      BANGUMI_GIT_COMMIT_SHA: '0123456789abcdef',
      BANGUMI_GIT_REPOSITORY_URL: 'https://github.com/markd3ng/AiringCal',
    },
  })

  assert.equal(
    readFileSync(target, 'utf8'),
    `name = "airing-cal-frontend"\nmain = "../apps/frontend-worker/src/index.ts"\nkeep_vars = true\n\n[vars]\nBANGUMI_GIT_COMMIT_SHA = "0123456789abcdef"\nBANGUMI_GIT_REPOSITORY_URL = "https://github.com/markd3ng/AiringCal"\n`,
  )
})
