import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ciPath = resolve(root, '.github/workflows/ci.yml')

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
  assert.equal(existsSync(resolve(root, '.github/workflows/deploy.yml')), false)
  assert.equal(existsSync(resolve(root, 'scripts/push-sync-trigger.mjs')), false)
})

test('unified CI pipeline validates, bundles, and deploys without duplicate quality gates', () => {
  const workflow = readFileSync(ciPath, 'utf8')
  const jobs = new Map<string, string[]>()
  const jobMatches = [...workflow.matchAll(/^  ([a-z][a-z0-9_-]+):\s*$/gm)]
  for (const [index, match] of jobMatches.entries()) {
    const start = (match.index ?? 0) + match[0].length
    const end = jobMatches[index + 1]?.index ?? workflow.length
    const body = workflow.slice(start, end)
    const bracketNeeds = body.match(/^    needs:\s*\[([^\]]+)\]\s*$/m)?.[1]
    const singleNeed = body.match(/^    needs:\s*([a-z][a-z0-9_-]+)\s*$/m)?.[1]
    const needs = bracketNeeds
      ? bracketNeeds.split(',').map((job) => job.trim())
      : singleNeed
        ? [singleNeed]
        : []
    jobs.set(match[1], needs)
  }

  assert.match(workflow, /push:[\s\S]*?branches:\s*\[dev\][\s\S]*?paths-ignore:/, 'dev push should skip docs-only paths')
  assert.match(workflow, /pull_request:/, 'PRs should run quality gates')
  assert.match(workflow, /workflow_dispatch:/, 'manual redeploy should stay on the same workflow')
  assert.match(workflow, /cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/, 'only PRs should cancel stale runs')
  assert.match(workflow, /matrix:[\s\S]*?task:\s*\[typecheck, test, build:check\]/, 'validate should run checks in parallel')
  assert.doesNotMatch(workflow, /-\s+run:\s+pnpm typecheck[\s\S]*-\s+run:\s+pnpm test/, 'validate must not run the full gate serially in one job')

  assert.ok(jobs.get('node-jobs-bundle')?.includes('validate'), 'bundle should wait for validate matrix')
  assert.ok(jobs.get('resolve_cloudflare')?.includes('resolve_ref'), 'cloudflare resolve should not wait for validate')
  assert.deepEqual(jobs.get('deploy_web_worker'), ['resolve_ref', 'validate', 'resolve_cloudflare'])

  assert.match(workflow, /deploy_web_worker:[\s\S]*?concurrency:[\s\S]*?group:\s*deploy-cloudflare[\s\S]*?cancel-in-progress:\s*false/, 'deploy job should serialize without cancelling in-flight uploads')

  assert.match(workflow, /resolve_ref:[\s\S]*?outputs:[\s\S]*?sha:\s*\$\{\{ steps\.resolve\.outputs\.sha \}\}/, 'a no-secret job should resolve one immutable deployment SHA')
  assert.match(workflow, /git merge-base --is-ancestor "\$sha" origin\/dev/, 'manual refs must already be ancestors of dev')
  assert.doesNotMatch(workflow.match(/resolve_ref:[\s\S]*?\n  validate:/)?.[0] ?? '', /secrets\./, 'ref validation must not receive production secrets')
  assert.match(workflow, /apps\/web-worker\/wrangler\.toml/, 'workflow should deploy checked-in web-worker config')
  assert.match(workflow, /node scripts\/resolve-cloudflare-resources\.mjs/, 'workflow should use the read-only resource resolver')
  assert.match(workflow, /node scripts\/list-cloudflare-crons\.mjs --deploy apps\/web-worker\/wrangler\.toml/, 'cron quota must project the web-worker upload before deploy')
  assert.ok(workflow.indexOf('node scripts/list-cloudflare-crons.mjs') < workflow.indexOf('pnpm exec wrangler deploy'), 'cron preflight must run before wrangler deploy')

  assert.match(workflow, /Apply D1 migrations/, 'deploy job should apply remote D1 migrations')
  assert.match(workflow, /pnpm exec wrangler d1 migrations apply AIRING_CAL_D1 --remote/, 'D1 migration should use the verified remote migration command')
  assert.match(workflow, /pnpm exec wrangler deploy --config/, 'deploy job should upload web-worker with materialized Wrangler config')
  assert.doesNotMatch(workflow, /wrangler deploy --dry-run/, 'dry-run belongs in build:check matrix, not deploy')

  assert.match(workflow, /BANGUMI_GIT_COMMIT_SHA:\s*\$\{\{ needs\.resolve_ref\.outputs\.sha \}\}/, 'web worker deploy should stamp the resolved deployment sha')
  assert.match(workflow, /qinglong-bundle/, 'push dev should publish the QingLong bundle artifact')
  assert.match(workflow, /gh workflow run ci\.yml --ref dev -f ref=\$\{\{ needs\.resolve_ref\.outputs\.sha \}\}/, 'recovery report should provide an exact immutable convergence command')

  for (const job of ['resolve_ref', 'validate', 'node-jobs-bundle', 'resolve_cloudflare', 'deploy_web_worker', 'recovery_report']) {
    assert.match(workflow, new RegExp(`${job}:[\\s\\S]*?timeout-minutes:`), `${job} should have a timeout`)
  }

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
    '.github/workflows/deploy.yml',
  ]
  for (const fragment of forbidden) {
    assert.doesNotMatch(workflow, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `workflow should not contain ${fragment}`)
  }
})

test('bootstrap workflow stays manual-only', () => {
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
