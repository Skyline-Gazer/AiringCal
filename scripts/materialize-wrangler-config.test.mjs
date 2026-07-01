import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./materialize-wrangler-config.mjs', import.meta.url))

test('materialize-wrangler-config replaces the checked-in KV placeholder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-wrangler-config-'))
  const source = join(dir, 'wrangler.toml')
  const target = join(dir, 'deploy', 'wrangler.toml')
  const namespaceId = '0123456789abcdef0123456789abcdef'

  writeFileSync(source, 'id = "<AIRING_CAL_KV_NAMESPACE_ID>"\n')

  execFileSync(process.execPath, [script, source, target], {
    env: { ...process.env, AIRING_CAL_KV_NAMESPACE_ID: namespaceId },
  })

  assert.equal(readFileSync(target, 'utf8'), `id = "${namespaceId}"\n`)
})

test('materialize-wrangler-config rewrites main relative to the target config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-wrangler-config-'))
  const source = join(dir, 'apps', 'sync-worker', 'wrangler.toml')
  const target = join(dir, 'runner-temp', 'wrangler-sync-worker.toml')
  const namespaceId = '0123456789abcdef0123456789abcdef'

  mkdirSync(join(dir, 'apps', 'sync-worker'), { recursive: true })
  writeFileSync(source, 'name = "airing-cal-sync"\nmain = "src/index.ts"\nid = "<AIRING_CAL_KV_NAMESPACE_ID>"\n')

  execFileSync(process.execPath, [script, source, target], {
    env: { ...process.env, AIRING_CAL_KV_NAMESPACE_ID: namespaceId },
  })

  assert.equal(
    readFileSync(target, 'utf8'),
    `name = "airing-cal-sync"\nmain = "../apps/sync-worker/src/index.ts"\nid = "${namespaceId}"\n`,
  )
})

test('materialize-wrangler-config rejects missing or invalid KV namespace ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airing-cal-wrangler-config-'))
  const source = join(dir, 'wrangler.toml')
  const target = join(dir, 'deploy', 'wrangler.toml')

  writeFileSync(source, 'id = "<AIRING_CAL_KV_NAMESPACE_ID>"\n')

  assert.throws(
    () => execFileSync(process.execPath, [script, source, target], {
      env: { ...process.env, AIRING_CAL_KV_NAMESPACE_ID: '<AIRING_CAL_KV_NAMESPACE_ID>' },
      stdio: 'pipe',
    }),
    /Command failed/,
  )
})
