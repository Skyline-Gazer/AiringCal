import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const appConfigs = [
  ['frontend-worker', ['[[services]]', 'READ_WORKER', 'SYNC_WORKER']],
  ['read-worker', ['[[kv_namespaces]]', '[[r2_buckets]]']],
  ['sync-worker', ['[[queues.producers]]', '[[workflows]]', 'binding = "SYNC_WORKFLOW"', 'class_name = "SyncWorkflow"', '[triggers]', 'crons = ["0 */4 * * *"]']],
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

test('media queue consumer uses Free Plan concurrency limits', () => {
  const config = readFileSync(resolve(root, 'apps/media-worker/wrangler.toml'), 'utf8')
  assert.match(config, /^max_batch_size = 1$/m)
  assert.match(config, /^max_batch_timeout = 5$/m)
  assert.match(config, /^max_concurrency = 4$/m)
  assert.match(config, /^max_retries = 3$/m)
})

test('Free Plan Cron only triggers the Workflow without a legacy Queue consumer', () => {
  const config = readFileSync(resolve(root, 'apps/sync-worker/wrangler.toml'), 'utf8')
  assert.match(config, /^main = "src\/production\.ts"$/m)
  assert.match(config, /^name = "airing-cal-sync"$/m)
  assert.match(config, /^binding = "SYNC_WORKFLOW"$/m)
  assert.match(config, /^class_name = "SyncWorkflow"$/m)
  assert.match(config, /^\[triggers\]$/m)
  assert.match(config, /^crons = \["0 \*\/4 \* \* \*"\]$/m)
  assert.doesNotMatch(config, /^schedules =/m)
  assert.doesNotMatch(config, /^\[\[queues\.consumers\]\]$/m)
  assert.doesNotMatch(config, /airing-cal-sync-trigger/)
  assert.equal(existsSync(resolve(root, 'scripts/push-sync-trigger.mjs')), false)
  assert.equal(existsSync(resolve(root, 'scripts/push-sync-trigger.test.mjs')), false)
})

test('deploy workflow resolves existing resources without waiting for business sync', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8')
  assert.match(workflow, /push:\s*\n\s+branches:\s*\[dev\]/, 'only dev should deploy automatically')
  assert.doesNotMatch(workflow, /branches:\s*\[[^\]]*main/, 'main should not compete for the same workers')
  assert.match(workflow, /concurrency:\s*\n\s+group:\s*deploy-cloudflare\s*\n\s+cancel-in-progress:\s*false/, 'deployments should be serialized without cancelling the active run')
  assert.match(workflow, /resolve_ref:[\s\S]*?outputs:[\s\S]*?sha:\s*\$\{\{ steps\.resolve\.outputs\.sha \}\}/, 'a no-secret job should resolve one immutable deployment SHA')
  assert.match(workflow, /git merge-base --is-ancestor "\$sha" origin\/dev/, 'manual refs must already be ancestors of dev')
  assert.doesNotMatch(workflow.match(/resolve_ref:[\s\S]*?\n  validate:/)?.[0] ?? '', /secrets\./, 'ref validation must not receive production secrets')
  for (const app of ['read-worker', 'sync-worker', 'media-worker']) {
    assert.match(workflow, new RegExp(`apps/${app}/wrangler\\.toml`), `workflow should deploy checked-in ${app} config`)
  }
  assert.match(workflow, /apps\/frontend-worker\/wrangler\.toml/, 'workflow should deploy frontend config')
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, 'workflow should expose CLOUDFLARE_API_TOKEN to wrangler')
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/, 'workflow should expose CLOUDFLARE_ACCOUNT_ID to wrangler')
  assert.match(workflow, /resolve_cloudflare:/, 'workflow should resolve existing Cloudflare resources before deploy')
  assert.match(workflow, /node scripts\/resolve-cloudflare-resources\.mjs/, 'workflow should use the read-only resource resolver')
  assert.match(workflow, /kv_namespace_id:\s*\$\{\{ steps\.resolve\.outputs\.kv_namespace_id \}\}/, 'workflow should expose the resolved KV namespace id as a job output')
  assert.match(workflow, /deploy_read_media_workers:/, 'workflow should deploy read and media workers through a matrix job')
  assert.match(workflow, /deploy_sync_worker:/, 'workflow should deploy sync worker after read and media workers')
  assert.match(workflow, /deploy_sync_worker:[\s\S]*?needs:\s*\[resolve_ref, validate, resolve_cloudflare, deploy_read_media_workers\]/, 'sync worker should wait for ref validation, resource resolution, read and media workers')
  assert.match(workflow, /pnpm exec wrangler workflows describe airing-cal-sync/, 'workflow should verify the deployed Workflow control plane')
  assert.match(workflow, /deploy_frontend_worker:/, 'workflow should deploy the public frontend after internal workers')
  assert.match(workflow, /deploy_frontend_worker:[\s\S]*?needs:\s*\[resolve_ref, validate, resolve_cloudflare, deploy_sync_worker\]/, 'frontend should wait for the Workflow control-plane check')
  for (const job of ['resolve_ref', 'validate', 'resolve_cloudflare', 'deploy_read_media_workers', 'deploy_sync_worker', 'deploy_frontend_worker']) {
    assert.match(workflow, new RegExp(`${job}:[\\s\\S]*?timeout-minutes:`), `${job} should have a timeout`)
  }
  assert.match(workflow, /BANGUMI_GIT_COMMIT_SHA:\s*\$\{\{ needs\.resolve_ref\.outputs\.sha \}\}/, 'frontend deploy should stamp the resolved deployment sha')
  assert.match(workflow, /BANGUMI_GIT_REPOSITORY_URL:\s*https:\/\/github\.com\/\$\{\{ github\.repository \}\}/, 'frontend deploy should stamp the repository URL')
  assert.match(workflow, /AIRING_CAL_KV_NAMESPACE_ID:\s*\$\{\{ needs\.resolve_cloudflare\.outputs\.kv_namespace_id \}\}/, 'workflow should pass the resolved KV namespace id to materialize deploy configs')
  assert.match(workflow, /node scripts\/materialize-wrangler-config\.mjs \$\{\{ matrix\.config \}\} \$\{\{ runner\.temp \}\}\/wrangler-\$\{\{ matrix\.app \}\}\.toml/, 'workflow should materialize internal worker configs before deploying')
  assert.match(workflow, /pnpm exec wrangler deploy --config \$\{\{ runner\.temp \}\}\/wrangler-\$\{\{ matrix\.app \}\}\.toml/, 'workflow should deploy internal workers with materialized Wrangler configs')
  assert.match(workflow, /WRANGLER_LOG_PATH:\s*\$\{\{ runner\.temp \}\}\/wrangler-\$\{\{ matrix\.app \}\}\.log/, 'workflow should save Wrangler debug logs for matrix deploys')
  assert.match(workflow, /WRANGLER_LOG_SANITIZE:\s*"false"/, 'workflow should include unsanitized Wrangler response bodies for failed deploy diagnosis')
  assert.match(workflow, /node scripts\/list-cloudflare-crons\.mjs/, 'cron quota must be checked before deploying any worker')
  assert.ok(workflow.indexOf('node scripts/list-cloudflare-crons.mjs') < workflow.indexOf('pnpm exec wrangler deploy --config'), 'cron quota preflight must run before the first worker upload')
  const checkoutRefs = [...workflow.matchAll(/ref:\s*\$\{\{ needs\.resolve_ref\.outputs\.sha \}\}/g)]
  assert.equal(checkoutRefs.length, 6, 'every post-resolution job, including recovery reporting, must checkout the same immutable SHA')
  assert.match(workflow, /recovery_report:[\s\S]*?if:\s*\$\{\{ always\(\) &&/, 'partial failures should produce an always-evaluated recovery report')
  for (const worker of ['airing-cal-read', 'airing-cal-media', 'airing-cal-sync', 'airing-cal-frontend']) {
    assert.match(workflow, new RegExp(`for worker in [^\n]*${worker}`), `recovery report should include ${worker}`)
  }
  assert.match(workflow, /wrangler deployments list --name "\$worker" --json/, 'recovery report should query each deployed worker version')
  assert.match(workflow, /gh workflow run deploy\.yml --ref dev -f ref=\$\{\{ needs\.resolve_ref\.outputs\.sha \}\}/, 'recovery report should provide an exact immutable convergence command')
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
    'replaceAll(',
    'wrangler secret put',
    'CRON_SECRET',
    'python3 -',
    '/__cron/sync',
    'provision_cloudflare:',
    'node scripts/provision-cloudflare-resources.mjs',
    'refresh_cache_after_internal_deploy:',
    'node scripts/push-sync-trigger.mjs',
    'sync:meta.synced_at',
  ]
  for (const fragment of forbidden) {
    assert.doesNotMatch(workflow, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `workflow should not contain ${fragment}`)
  }
})

test('CI validates every code push while bootstrap is manual', () => {
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
  assert.match(ci, /push:/)
  assert.match(ci, /pnpm typecheck/)
  assert.match(ci, /pnpm test/)
  assert.match(ci, /pnpm build:check/)

  const bootstrap = readFileSync(resolve(root, '.github/workflows/bootstrap-cloudflare.yml'), 'utf8')
  assert.match(bootstrap, /workflow_dispatch:/)
  assert.doesNotMatch(bootstrap, /\npush:/)
  assert.match(bootstrap, /node scripts\/provision-cloudflare-resources\.mjs/)
})

test('manual Workflow trigger uses GitHub secrets without exposing a public sync endpoint', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/sync-workflow.yml'), 'utf8')
  assert.match(workflow, /^name: Manual Sync Workflow$/m)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /- trigger[\s\S]*?- describe[\s\S]*?- restart[\s\S]*?- terminate[\s\S]*?- cleanup-legacy-consumer/)
  assert.match(workflow, /type: choice[\s\S]*?options:[\s\S]*?- shadow[\s\S]*?- live/)
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/)
  assert.match(workflow, /wrangler workflows trigger airing-cal-sync/)
  assert.match(workflow, /wrangler workflows instances describe airing-cal-sync/)
  assert.match(workflow, /wrangler workflows instances restart airing-cal-sync/)
  assert.match(workflow, /wrangler workflows instances terminate airing-cal-sync/)
  assert.match(workflow, /wrangler queues consumer remove airing-cal-sync-trigger airing-cal-sync/)
  assert.doesNotMatch(workflow, /schedule:/)
})

test('README documents the Free Plan Cron bridge without a native Workflow schedule', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
  for (const fragment of ['frontend-worker', 'read-worker', 'sync-worker', 'media-worker', '/api/cache', '/api/health', 'images.common', 'images.large', 'Worker Cron', '0 */4 * * *', '手动 bootstrap workflow']) {
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
  for (const fragment of ['稳定的 checked-in `wrangler.toml`', '常规 deploy 只读解析实际 KV namespace ID', '不会触发业务同步', '不会轮询 KV', '不等待媒体缓存收敛']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document routine deploy boundaries: ${fragment}`)
  }
  for (const fragment of ['https://next.bgm.tv/demo/access-token', 'https://bgm.tv/user/sai', 'sai,another_user', '只配置在 `airing-cal-sync`']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document how to configure bgm runtime value: ${fragment}`)
  }
  for (const fragment of ['`subject:refresh:{subject_id}`', '`job_id`', '6 至 8 天', '`max_concurrency = 4`', '`image:status:{subject_id}` 只描述真实图片缓存结果']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document media refresh lifecycle: ${fragment}`)
  }
  for (const fragment of ['Cloudflare Workflows Free Plan 不支持原生 Workflow schedule', 'Cron handler 只创建 Workflow instance', '0 */4 * * *', '`sync:run:{instanceId}`', '`sync:staging:{instanceId}:*`', '`snapshot:shadow:{instanceId}:*`', 'workflows trigger airing-cal-sync', 'workflows instances describe', 'workflows instances restart', 'workflows instances terminate']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document shadow Workflow operations: ${fragment}`)
  }
  assert.doesNotMatch(readme, /^schedules\s*=/m)
  for (const fragment of ['BANGUMI_GIT_COMMIT_SHA', 'BANGUMI_GIT_REPOSITORY_URL', '绑定自定义域名不需要改任何 repository URL 变量']) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document optional frontend build metadata: ${fragment}`)
  }
  for (const fragment of ['secrets.CF_API_TOKEN', 'secrets.CF_ACCOUNT_ID', 'CRON_SECRET', '/__cron/sync', 'bangumi-theme', 'images.hash', 'hash_large', '内联 placeholder', 'Workers Queues: Edit', 'Workers Routes: Edit', '通过 CI 上传 Worker secrets', 'PUBLIC_REPOSITORY_URL', 'wrangler.deploy.toml', 'pre-check Cloudflare 资源', '部署完成后自动投递一次', 'CI 会向 `airing-cal-sync-trigger` 自动投递', '旧 Cron 仍是正式触发源', 'airing-cal-sync-trigger']) {
    assert.doesNotMatch(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should not mention ${fragment}`)
  }
})
