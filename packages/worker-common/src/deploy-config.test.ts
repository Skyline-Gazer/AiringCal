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
    ['frontend-worker', ['name = "airing-cal-frontend"', 'service = "airing-cal-read"']],
    ['read-worker', ['name = "airing-cal-read"', 'id = "<AIRING_CAL_KV_NAMESPACE_ID>"', 'bucket_name = "airing-cal-images"']],
    ['sync-worker', ['name = "airing-cal-sync"', 'id = "<AIRING_CAL_KV_NAMESPACE_ID>"', 'queue = "airing-cal-media"']],
    ['media-worker', ['name = "airing-cal-media"', 'id = "<AIRING_CAL_KV_NAMESPACE_ID>"', 'bucket_name = "airing-cal-images"', 'queue = "airing-cal-media"']],
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

test('deploy workflow pre-checks resources, resolves KV id, and avoids secret or schedule mutation', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8')
  for (const app of ['read-worker', 'sync-worker', 'media-worker']) {
    assert.match(workflow, new RegExp(`apps/${app}/wrangler\\.deploy\\.toml`), `workflow should deploy resolved ${app} config`)
  }
  assert.match(workflow, /apps\/frontend-worker\/wrangler\.toml/, 'workflow should deploy frontend config')
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CF_API_TOKEN \}\}/, 'workflow should expose CLOUDFLARE_API_TOKEN to wrangler')
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CF_ACCOUNT_ID \}\}/, 'workflow should expose CLOUDFLARE_ACCOUNT_ID to wrangler')
  assert.match(workflow, /wrangler kv namespace list/, 'workflow should pre-check KV namespaces')
  assert.match(workflow, /wrangler kv namespace create "\$KV_TITLE"/, 'workflow should create the KV namespace when missing')
  assert.match(workflow, /wrangler r2 bucket info "\$R2_BUCKET" --json/, 'workflow should pre-check the R2 bucket')
  assert.match(workflow, /wrangler r2 bucket create "\$R2_BUCKET"/, 'workflow should create the R2 bucket when missing')
  assert.match(workflow, /wrangler queues info "\$QUEUE_NAME"/, 'workflow should pre-check the Queue')
  assert.match(workflow, /wrangler queues create "\$QUEUE_NAME"/, 'workflow should create the Queue when missing')
  assert.match(workflow, /replaceAll\('<AIRING_CAL_KV_NAMESPACE_ID>', kvId\)/, 'workflow should resolve the KV namespace id in temporary deploy configs')
  assert.match(workflow, /deploy_internal_workers:/, 'workflow should deploy internal workers through a matrix job')
  assert.match(workflow, /deploy_frontend_worker:/, 'workflow should deploy the public frontend after internal workers')

  const forbidden = [
    'wrangler secret put',
    'CRON_SECRET',
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
  for (const fragment of ['Workers Scripts', 'Workers KV Storage', 'Workers R2 Storage', 'Queues', 'Account Settings', 'User Details', 'Workers Routes']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document CF_API_TOKEN permission ${fragment}`)
  }
  for (const fragment of ['Repository secrets', 'New repository secret', '当前 workflow 没有设置 GitHub Actions `environment:`', '不是 Environment secrets']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should explain which GitHub secrets scope to use: ${fragment}`)
  }
  for (const fragment of ['pre-check Cloudflare 资源', 'wrangler.deploy.toml', '找不到就创建']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document CI resource provisioning: ${fragment}`)
  }
  for (const fragment of ['https://next.bgm.tv/demo/access-token', 'https://bgm.tv/user/sai', 'sai,another_user', '只配置在 `airing-cal-sync`']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document how to configure bgm runtime value: ${fragment}`)
  }
  for (const fragment of ['BANGUMI_GIT_COMMIT_SHA', 'BANGUMI_GIT_REPOSITORY_URL', '绑定自定义域名不需要改任何 repository URL 变量']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document optional frontend build metadata: ${fragment}`)
  }
  for (const fragment of ['CRON_SECRET', '/__cron/sync', 'bangumi-theme', 'images.hash', 'hash_large', 'Workers Queues: Edit', 'Workers Routes: Edit', '通过 CI 上传 Worker secrets', 'PUBLIC_REPOSITORY_URL']) {
    assert.doesNotMatch(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should not mention ${fragment}`)
  }
})
