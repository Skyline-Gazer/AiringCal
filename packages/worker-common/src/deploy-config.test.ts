import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const productionApps = ['web-worker', 'node-jobs'] as const

test('pnpm workspace lists only production apps plus shared packages', () => {
  const workspace = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, /apps\/web-worker/)
  assert.match(workspace, /apps\/node-jobs/)
  assert.match(workspace, /packages\/\*/)
  assert.doesNotMatch(workspace, /apps\/\*/)
  for (const legacy of ['vps-sync', 'sync-worker', 'media-worker', 'read-worker', 'frontend-worker']) {
    assert.doesNotMatch(workspace, new RegExp(legacy))
  }
})

test('production web-worker has a checked-in Wrangler config with required bindings', () => {
  const config = readFileSync(resolve(root, 'apps/web-worker/wrangler.toml'), 'utf8')
  for (const fragment of [
    '[[d1_databases]]',
    'binding = "AIRING_CAL_D1"',
    '[[kv_namespaces]]',
    'binding = "AIRING_CAL_KV"',
    'binding = "AIRING_CAL_R2"',
    'binding = "AIRING_CAL_DATA_R2"',
    'binding = "IMAGES"',
    'name = "airing-cal-frontend"',
  ]) {
    assert.match(config, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.doesNotMatch(config, /bangumi-tv/)
  assert.match(config, /keep_vars = true/)
})

test('public web-worker read path keeps R2 snapshot bindings and legacy fallback', () => {
  const readApi = readFileSync(resolve(root, 'apps/web-worker/src/read-api.ts'), 'utf8')
  const r2Snapshot = readFileSync(resolve(root, 'apps/web-worker/src/r2-snapshot.ts'), 'utf8')
  const readEnv = readApi.match(/interface ReadEnv \{[\s\S]*?\n\}/)?.[0] ?? ''

  assert.match(readEnv, /AIRING_CAL_D1:/)
  assert.match(readEnv, /AIRING_CAL_DATA_R2:/)
  assert.match(readApi, /readSnapshotSource/)
  assert.match(readApi, /buildMigrationHealth/)
  assert.match(r2Snapshot, /mode: 'legacy'/, 'the R2 read path keeps a legacy KV fallback')
})

test('public web-worker does not register Worker cron triggers', () => {
  const config = readFileSync(resolve(root, 'apps/web-worker/wrangler.toml'), 'utf8')
  assert.doesNotMatch(config, /^\[triggers\]$/m)
  assert.doesNotMatch(config, /^crons =/m)
})

test('legacy Cloudflare write Workers are removed from the repo', () => {
  for (const app of ['vps-sync', 'frontend-worker', 'read-worker', 'sync-worker', 'media-worker']) {
    assert.equal(existsSync(resolve(root, 'apps', app)), false, `${app} should be removed; use git history`)
  }
  assert.equal(existsSync(resolve(root, '.github/workflows/sync-workflow.yml')), false)
  assert.equal(existsSync(resolve(root, 'scripts/push-sync-trigger.mjs')), false)
})

test('deploy workflow resolves existing resources without waiting for business sync', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8')
  const jobs = new Map<string, string[]>()
  const jobMatches = [...workflow.matchAll(/^  ([a-z][a-z0-9_]+):\s*$/gm)]
  for (const [index, match] of jobMatches.entries()) {
    const start = (match.index ?? 0) + match[0].length
    const end = jobMatches[index + 1]?.index ?? workflow.length
    const body = workflow.slice(start, end)
    const needs = body.match(/^    needs:\s*\[([^\]]+)\]\s*$/m)?.[1]
      .split(',')
      .map((job) => job.trim()) ?? []
    jobs.set(match[1], needs)
  }
  const deployOrder = ['resolve_cloudflare']
  for (const nextJob of ['apply_d1_migrations', 'deploy_web_worker']) {
    assert.ok(jobs.get(nextJob)?.includes(deployOrder.at(-1) ?? ''), `${nextJob} should need ${deployOrder.at(-1)}`)
    deployOrder.push(nextJob)
  }
  assert.deepEqual(deployOrder, ['resolve_cloudflare', 'apply_d1_migrations', 'deploy_web_worker'])

  assert.match(workflow, /push:\s*\n\s+branches:\s*\[dev\]/, 'only dev should deploy automatically')
  assert.doesNotMatch(workflow, /branches:\s*\[[^\]]*main/, 'main should not compete for the same workers')
  assert.match(workflow, /concurrency:\s*\n\s+group:\s*deploy-cloudflare\s*\n\s+cancel-in-progress:\s*false/, 'deployments should be serialized without cancelling the active run')
  assert.match(workflow, /resolve_ref:[\s\S]*?outputs:[\s\S]*?sha:\s*\$\{\{ steps\.resolve\.outputs\.sha \}\}/, 'a no-secret job should resolve one immutable deployment SHA')
  assert.match(workflow, /git merge-base --is-ancestor "\$sha" origin\/dev/, 'manual refs must already be ancestors of dev')
  assert.doesNotMatch(workflow.match(/resolve_ref:[\s\S]*?\n  validate:/)?.[0] ?? '', /secrets\./, 'ref validation must not receive production secrets')
  assert.match(workflow, /apps\/web-worker\/wrangler\.toml/, 'workflow should deploy checked-in web-worker config')
  assert.match(workflow, /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, 'workflow should expose CLOUDFLARE_API_TOKEN to wrangler')
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/, 'workflow should expose CLOUDFLARE_ACCOUNT_ID to wrangler')
  assert.match(workflow, /resolve_cloudflare:/, 'workflow should resolve existing Cloudflare resources before deploy')
  assert.match(workflow, /node scripts\/resolve-cloudflare-resources\.mjs/, 'workflow should use the read-only resource resolver')
  assert.match(workflow, /kv_namespace_id:\s*\$\{\{ steps\.resolve\.outputs\.kv_namespace_id \}\}/, 'workflow should expose the resolved KV namespace id as a job output')
  assert.match(workflow, /d1_database_id:\s*\$\{\{ steps\.resolve\.outputs\.d1_database_id \}\}/, 'workflow should expose the resolved D1 database id as a job output')
  assert.match(workflow, /apply_d1_migrations:[\s\S]*?needs:\s*\[resolve_ref, validate, resolve_cloudflare\]/, 'D1 migration should wait for resource resolution')
  assert.match(workflow, /apply_d1_migrations:[\s\S]*?AIRING_CAL_D1_DATABASE_ID:\s*\$\{\{ needs\.resolve_cloudflare\.outputs\.d1_database_id \}\}/, 'D1 migration should materialize the resolved database id')
  assert.match(workflow, /apply_d1_migrations:[\s\S]*?node scripts\/materialize-wrangler-config\.mjs apps\/web-worker\/wrangler\.toml "\$RUNNER_TEMP\/wrangler-web-worker\.toml"/, 'D1 migration should materialize its config before applying migrations')
  assert.match(workflow, /pnpm exec wrangler d1 migrations apply AIRING_CAL_D1 --remote --config "\$RUNNER_TEMP\/wrangler-web-worker\.toml"/, 'D1 migration should use the verified remote migration command')
  assert.match(workflow, /deploy_web_worker:/, 'workflow should deploy the merged web worker')
  assert.match(workflow, /deploy_web_worker:[\s\S]*?needs:\s*\[resolve_ref, validate, resolve_cloudflare, apply_d1_migrations\]/, 'web worker deploy should wait for D1 migration')
  for (const job of ['resolve_ref', 'validate', 'resolve_cloudflare', 'apply_d1_migrations', 'deploy_web_worker']) {
    assert.match(workflow, new RegExp(`${job}:[\\s\\S]*?timeout-minutes:`), `${job} should have a timeout`)
  }
  assert.match(workflow, /BANGUMI_GIT_COMMIT_SHA:\s*\$\{\{ needs\.resolve_ref\.outputs\.sha \}\}/, 'web worker deploy should stamp the resolved deployment sha')
  assert.match(workflow, /BANGUMI_GIT_REPOSITORY_URL:\s*https:\/\/github\.com\/\$\{\{ github\.repository \}\}/, 'frontend deploy should stamp the repository URL')
  assert.match(workflow, /AIRING_CAL_KV_NAMESPACE_ID:\s*\$\{\{ needs\.resolve_cloudflare\.outputs\.kv_namespace_id \}\}/, 'workflow should pass the resolved KV namespace id to materialize deploy configs')
  assert.match(workflow, /AIRING_CAL_D1_DATABASE_ID:\s*\$\{\{ needs\.resolve_cloudflare\.outputs\.d1_database_id \}\}/, 'workflow should pass the resolved D1 database id to materialize deploy configs')
  assert.match(workflow, /node scripts\/materialize-wrangler-config\.mjs apps\/web-worker\/wrangler\.toml \$\{\{ runner\.temp \}\}\/wrangler-web-worker\.toml/, 'workflow should materialize web-worker config before deploying')
  assert.match(workflow, /pnpm exec wrangler deploy --config \$\{\{ runner\.temp \}\}\/wrangler-web-worker\.toml/, 'workflow should deploy web-worker with materialized Wrangler config')
  assert.match(workflow, /WRANGLER_LOG_PATH:\s*\$\{\{ runner\.temp \}\}\/wrangler-web-worker\.log/, 'workflow should save Wrangler debug logs for web-worker deploy')
  assert.match(workflow, /WRANGLER_LOG_SANITIZE:\s*"false"/, 'workflow should include unsanitized Wrangler response bodies for failed deploy diagnosis')
  assert.match(workflow, /node scripts\/list-cloudflare-crons\.mjs --deploy apps\/web-worker\/wrangler\.toml/, 'cron quota must project the web-worker upload before deploy')
  assert.ok(workflow.indexOf('node scripts/list-cloudflare-crons.mjs') < workflow.indexOf('pnpm exec wrangler deploy --config'), 'cron quota preflight must run before the first worker upload')
  const checkoutRefs = [...workflow.matchAll(/ref:\s*\$\{\{ needs\.resolve_ref\.outputs\.sha \}\}/g)]
  assert.equal(checkoutRefs.length, 5, 'every post-resolution job, including migration and recovery reporting, must checkout the same immutable SHA')
  assert.match(workflow, /recovery_report:[\s\S]*?if:\s*\$\{\{ always\(\) &&/, 'partial failures should produce an always-evaluated recovery report')
  for (const worker of ['airing-cal-frontend']) {
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
    'sync-workflow.yml',
    'airing-cal-sync',
  ]
  for (const fragment of forbidden) {
    assert.doesNotMatch(workflow, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `workflow should not contain ${fragment}`)
  }
})

test('CI validates pull requests and dev pushes without retaining stale runs', () => {
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
  const filteredPullRequestFixture = `on:
  pull_request:
    branches: [dev]
`
  const unfilteredTriggerBlock = /^on:\n  push:\n    branches: \[dev\]\n  pull_request:\n\nconcurrency:/m
  assert.doesNotMatch(filteredPullRequestFixture, unfilteredTriggerBlock, 'filtered pull request triggers must not satisfy the unfiltered trigger check')
  assert.match(ci, /push:\s*\n\s+branches:\s*\[dev\]/, 'CI should run on pushes to dev only')
  assert.match(ci, unfilteredTriggerBlock, 'CI should use default pull request activities without branch or path filters')
  assert.match(ci, /concurrency:\s*\n\s+group:\s*\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*\n\s+cancel-in-progress:\s*true/, 'CI should cancel stale runs only within this workflow and ref')
  assert.match(ci, /pnpm install --frozen-lockfile/)
  assert.match(ci, /pnpm typecheck/)
  assert.match(ci, /pnpm test/)
  assert.match(ci, /pnpm build:check/)

  const bootstrap = readFileSync(resolve(root, '.github/workflows/bootstrap-cloudflare.yml'), 'utf8')
  assert.match(bootstrap, /workflow_dispatch:/)
  assert.doesNotMatch(bootstrap, /\npush:/)
  assert.match(bootstrap, /node scripts\/provision-cloudflare-resources\.mjs/)
  assert.match(bootstrap, /id:\s*resolve[\s\S]*?node scripts\/resolve-cloudflare-resources\.mjs/, 'bootstrap should resolve every provisioned resource with the same production credentials')
  assert.match(bootstrap, /steps\.resolve\.outputs\.d1_database_id/, 'bootstrap should report the resolver-confirmed D1 database id')
  assert.match(bootstrap, /steps\.resolve\.outputs\.kv_namespace_id/, 'bootstrap should report the resolver-confirmed KV namespace id')
  const provisionIndex = bootstrap.indexOf('node scripts/provision-cloudflare-resources.mjs')
  const resolveIndex = bootstrap.indexOf('node scripts/resolve-cloudflare-resources.mjs')
  const reportIndex = bootstrap.indexOf('steps.resolve.outputs.d1_database_id')
  assert.ok(provisionIndex < resolveIndex, 'bootstrap should resolve resources only after provisioning succeeds')
  assert.ok(resolveIndex < reportIndex, 'bootstrap should report only resolver-confirmed outputs')
})

test('README is the Phase 0 entry and points to canonical docs', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
  for (const fragment of [
    'apps/web-worker',
    'airing-cal-frontend',
    'qinglong-bundle',
    'apps/node-jobs',
    'START_HERE_FOR_AI.md',
    'docs/README.md',
    'docs/archive/README.md',
    'QINGLONG operator-checklist',
  ]) {
    assert.match(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should document ${fragment}`)
  }
  for (const fragment of ['frontend-worker', 'sync-worker', 'media-worker', '0 */4 * * *', 'airing-cal-sync-trigger']) {
    assert.doesNotMatch(readme, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README should not present legacy production path: ${fragment}`)
  }
})

test('node-jobs remains the QingLong write bundle entry', () => {
  for (const app of productionApps) {
    assert.equal(existsSync(resolve(root, 'apps', app, 'package.json')), true, `${app} should remain`)
  }
  const nodeJobs = readFileSync(resolve(root, 'apps/node-jobs/package.json'), 'utf8')
  assert.match(nodeJobs, /"build"/)
})
