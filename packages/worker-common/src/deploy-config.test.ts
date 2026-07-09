import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const appConfigs = [
  ['frontend-worker', ['[[services]]', 'READ_WORKER', 'SYNC_WORKER']],
  ['read-worker', ['[[kv_namespaces]]', '[[r2_buckets]]']],
  ['sync-worker', ['[[queues.producers]]', '[[queues.consumers]]', '[triggers]', '0 * * * *']],
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
    ['sync-worker', ['name = "airing-cal-sync"', 'id = "<AIRING_CAL_KV_NAMESPACE_ID>"', 'queue = "airing-cal-media"', 'queue = "airing-cal-sync-trigger"']],
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

test('deploy workflow provisions resources and deploys checked-in worker configs', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8')
  for (const app of ['read-worker', 'sync-worker', 'media-worker']) {
    assert.match(workflow, new RegExp(`apps/${app}/wrangler\\.toml`), `workflow should deploy checked-in ${app} config`)
  }
  assert.match(workflow, /apps\/frontend-worker\/wrangler\.toml/, 'workflow should deploy frontend config')
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, 'workflow should expose CLOUDFLARE_API_TOKEN to wrangler')
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/, 'workflow should expose CLOUDFLARE_ACCOUNT_ID to wrangler')
  assert.match(workflow, /provision_cloudflare:/, 'workflow should create or reuse Cloudflare resources before deploy')
  assert.match(workflow, /node scripts\/provision-cloudflare-resources\.mjs/, 'workflow should run the provisioning script')
  assert.match(workflow, /provision_cloudflare:[\s\S]*?uses: actions\/setup-node@v5[\s\S]*?node-version: '24'\n\s+package-manager-cache: false[\s\S]*?node scripts\/provision-cloudflare-resources\.mjs/, 'provision job should disable setup-node automatic package manager cache because it does not install pnpm')
  assert.match(workflow, /kv_namespace_id:\s*\$\{\{ steps\.provision\.outputs\.kv_namespace_id \}\}/, 'workflow should expose the provisioned KV namespace id as a job output')
  assert.match(workflow, /deploy_internal_workers:/, 'workflow should deploy internal workers through a matrix job')
  assert.match(workflow, /deploy_frontend_worker:/, 'workflow should deploy the public frontend after internal workers')
  assert.match(workflow, /refresh_cache_after_internal_deploy:/, 'workflow should refresh snapshots and media cache after internal worker deploys')
  assert.match(workflow, /node scripts\/push-sync-trigger\.mjs/, 'workflow should push a sync trigger after internal workers deploy')
  assert.match(workflow, /refresh_cache_after_internal_deploy:[\s\S]*?uses: actions\/setup-node@v5[\s\S]*?node-version: '24'\n\s+package-manager-cache: false[\s\S]*?node scripts\/push-sync-trigger\.mjs/, 'refresh job should disable setup-node automatic package manager cache because it does not install pnpm')
  assert.match(workflow, /BANGUMI_GIT_COMMIT_SHA:\s*\$\{\{ github\.sha \}\}/, 'frontend deploy should stamp the current commit sha')
  assert.match(workflow, /BANGUMI_GIT_REPOSITORY_URL:\s*https:\/\/github\.com\/\$\{\{ github\.repository \}\}/, 'frontend deploy should stamp the repository URL')
  assert.match(workflow, /AIRING_CAL_KV_NAMESPACE_ID:\s*\$\{\{ needs\.provision_cloudflare\.outputs\.kv_namespace_id \}\}/, 'workflow should pass the provisioned KV namespace id to materialize deploy configs')
  assert.match(workflow, /node scripts\/materialize-wrangler-config\.mjs \$\{\{ matrix\.config \}\} \$\{\{ runner\.temp \}\}\/wrangler-\$\{\{ matrix\.app \}\}\.toml/, 'workflow should materialize internal worker configs before deploying')
  assert.match(workflow, /pnpm exec wrangler deploy --config \$\{\{ runner\.temp \}\}\/wrangler-\$\{\{ matrix\.app \}\}\.toml/, 'workflow should deploy internal workers with materialized Wrangler configs')
  assert.match(workflow, /WRANGLER_LOG_PATH:\s*\$\{\{ runner\.temp \}\}\/wrangler-\$\{\{ matrix\.app \}\}\.log/, 'workflow should save Wrangler debug logs for matrix deploys')
  assert.match(workflow, /WRANGLER_LOG_SANITIZE:\s*"false"/, 'workflow should include unsanitized Wrangler response bodies for failed deploy diagnosis')
  assert.match(workflow, /s\/\(Authorization: Bearer \)\[A-Za-z0-9\._-\]\+\/\\1\[redacted\]\/g/, 'workflow should redact bearer tokens in header-like Wrangler logs')
  assert.match(workflow, /s\/\("authorization": \?"Bearer \)\[A-Za-z0-9\._-\]\+\/\\1\[redacted\]\/gi/, 'workflow should redact bearer tokens in JSON-like Wrangler logs')

  const forbidden = [
    'cloudflare/wrangler-action',
    'apiToken:',
    'accountId:',
    'secrets.CF_API_TOKEN',
    'secrets.CF_ACCOUNT_ID',
    'trigger_deploy_sync:',
    'wrangler.deploy.toml',
    'node scripts/list-cloudflare-crons.mjs',
    'replaceAll(',
    'wrangler secret put',
    'CRON_SECRET',
    'python3 -',
    '/__cron/sync',
  ]
  for (const fragment of forbidden) {
    assert.doesNotMatch(workflow, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `workflow should not contain ${fragment}`)
  }
})

test('README documents the multi-worker deployment without legacy cron instructions', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
  for (const fragment of ['frontend-worker', 'read-worker', 'sync-worker', 'media-worker', '/api/cache', '/api/health', 'next cron time', 'images.common', 'images.large', 'Cloudflare 免费计划对 Cron Trigger 数量有限制', 'UTC 0/4/8/12/16/20 点真正同步', 'CI/CD 会创建或复用 Cloudflare 资源']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document ${fragment}`)
  }
  for (const fragment of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', '不要再创建 `CF_API_TOKEN` / `CF_ACCOUNT_ID`', 'Workers Scripts', 'Workers KV Storage', 'Workers R2 Storage', 'Queues', 'Account Settings', 'User Details', 'Workers Routes']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document CF_API_TOKEN permission ${fragment}`)
  }
  for (const fragment of ['Repository secrets', 'New repository secret', '当前 workflow 没有设置 GitHub Actions `environment:`', '不是 Environment secrets']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should explain which GitHub secrets scope to use: ${fragment}`)
  }
  for (const fragment of ['Some triggers failed to deploy for airing-cal-sync', '/workers/scripts/airing-cal-sync/schedules', 'Workers Scripts` 是 `Edit`', 'Node 20 deprecation 提示不是这次失败原因']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document sync-worker cron trigger permission troubleshooting: ${fragment}`)
  }
  for (const fragment of ['稳定的 checked-in `wrangler.toml`', 'CI 会自动获取实际 KV namespace ID', '自动投递一次完整同步消息', '新的 `sync:meta.synced_at`', '收藏 snapshot', '`calendar_synced_at` 只代表部署后的日历预热完成']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document routine deploy boundaries: ${fragment}`)
  }
  for (const fragment of ['https://next.bgm.tv/demo/access-token', 'https://bgm.tv/user/sai', 'sai,another_user', '只配置在 `airing-cal-sync`']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document how to configure bgm runtime value: ${fragment}`)
  }
  for (const fragment of ['BANGUMI_GIT_COMMIT_SHA', 'BANGUMI_GIT_REPOSITORY_URL', '绑定自定义域名不需要改任何 repository URL 变量']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document optional frontend build metadata: ${fragment}`)
  }
  for (const fragment of ['secrets.CF_API_TOKEN', 'secrets.CF_ACCOUNT_ID', 'CRON_SECRET', '/__cron/sync', 'bangumi-theme', 'images.hash', 'hash_large', '内联 placeholder', 'Workers Queues: Edit', 'Workers Routes: Edit', '通过 CI 上传 Worker secrets', 'PUBLIC_REPOSITORY_URL', 'wrangler.deploy.toml', 'pre-check Cloudflare 资源', '部署完成后自动投递一次']) {
    assert.doesNotMatch(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should not mention ${fragment}`)
  }
})
