import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const appConfigs = [
  ['frontend-worker', ['[[services]]', 'READ_WORKER']],
  ['read-worker', ['[[kv_namespaces]]', '[[r2_buckets]]']],
  ['sync-worker', ['[[queues.producers]]', '[triggers]', '0 */4 * * *']],
  ['media-worker', ['[[queues.consumers]]', '[[kv_namespaces]]', '[[r2_buckets]]']],
] as const

test('each target worker has a checked-in Wrangler config with required bindings', () => {
  for (const [app, expectedFragments] of appConfigs) {
    const path = resolve(root, 'apps', app, 'wrangler.toml')
    assert.equal(existsSync(path), true, `${app} wrangler.toml should exist`)
    const config = readFileSync(path, 'utf8')
    for (const fragment of expectedFragments) {
      assert.match(config, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${app} config should include ${fragment}`)
    }
  }
})

test('Cloudflare resource names use the AiringCal prefix', () => {
  const expected = new Map([
    ['frontend-worker', ['name = "airing-cal-frontend"', 'service = "airing-cal-read"', 'PUBLIC_REPOSITORY_URL = "https://github.com/markd3ng/AiringCal"']],
    ['read-worker', ['name = "airing-cal-read"', 'id = "airing-cal-kv"', 'bucket_name = "airing-cal-images"']],
    ['sync-worker', ['name = "airing-cal-sync"', 'id = "airing-cal-kv"', 'queue = "airing-cal-media"']],
    ['media-worker', ['name = "airing-cal-media"', 'id = "airing-cal-kv"', 'bucket_name = "airing-cal-images"', 'queue = "airing-cal-media"']],
  ])

  for (const [app, expectedFragments] of expected) {
    const config = readFileSync(resolve(root, 'apps', app, 'wrangler.toml'), 'utf8')
    assert.doesNotMatch(config, /bangumi-tv/, `${app} config should not use old Cloudflare resource names`)
    assert.match(config, /keep_vars = true/, `${app} config should preserve dashboard runtime vars`)
    for (const fragment of expectedFragments) {
      assert.match(config, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${app} config should include ${fragment}`)
    }
  }
})

test('deploy workflow uses checked-in app configs without provisioning or schedule mutation', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8')
  for (const app of appConfigs.map(([app]) => app)) {
    assert.match(workflow, new RegExp(`apps/${app}/wrangler\\.toml`), `workflow should deploy ${app} config`)
  }
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CF_API_TOKEN \}\}/, 'workflow should expose CLOUDFLARE_API_TOKEN to wrangler')
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CF_ACCOUNT_ID \}\}/, 'workflow should expose CLOUDFLARE_ACCOUNT_ID to wrangler')

  const forbidden = [
    'wrangler kv namespace create',
    'wrangler r2 bucket create',
    'wrangler kv namespace list',
    'wrangler secret put',
    'CRON_SECRET',
    'Inject KV id',
    'python3 -',
    '/schedules',
    '/__cron/sync',
  ]
  for (const fragment of forbidden) {
    assert.doesNotMatch(workflow, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `workflow should not contain ${fragment}`)
  }
})

test('README documents the multi-worker deployment without legacy cron instructions', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
  for (const fragment of ['frontend-worker', 'read-worker', 'sync-worker', 'media-worker', '/cache', 'images.common', 'images.large']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document ${fragment}`)
  }
  for (const fragment of ['Workers Scripts: Edit', 'Workers KV Storage: Edit', 'Workers R2 Storage: Edit', 'Workers Queues: Edit', 'Account Settings: Read', 'User Details: Read']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document CF_API_TOKEN permission ${fragment}`)
  }
  for (const fragment of ['CRON_SECRET', '/__cron/sync', 'bangumi-theme', 'images.hash', 'hash_large', 'wrangler kv namespace create', 'wrangler r2 bucket create']) {
    assert.doesNotMatch(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should not mention ${fragment}`)
  }
})
