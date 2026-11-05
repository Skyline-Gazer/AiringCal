import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const WORKFLOW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'v3-read-worker-staging.yml',
)

function workflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8')
}

test('v3 read staging deploy runs on workflow_dispatch only (C8)', () => {
  const source = workflow()
  assert.match(source, /^on:\n {2}workflow_dispatch:\n/m, 'only a workflow_dispatch trigger is allowed')
  for (const trigger of ['push', 'pull_request', 'schedule', 'workflow_run', 'release']) {
    assert.doesNotMatch(
      source,
      new RegExp(`^ {2}${trigger}:`, 'm'),
      `staging deploy must never run on ${trigger}`,
    )
  }
  assert.match(source, /^ {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}$/m)
})

test('v3 read staging deploy targets the staging Environment only (C8)', () => {
  const source = workflow()
  assert.match(source, /^ {4}environment: staging$/m)
  assert.doesNotMatch(source, /environment: production/)
  assert.match(source, /^ {4}if:.*workflow_dispatch/m)
  assert.doesNotMatch(source, /inputs\.target/, 'no production branch exists in this workflow')
})

test('v3 read staging deploy expands only AIRINGCAL_STAGING_ secrets and vars (C8)', () => {
  const source = workflow()
  const refs = [...source.matchAll(/(?:secrets|vars)\.([A-Za-z0-9_]+)/g)].map((match) => match[1])
  assert.ok(refs.length > 0, 'staging workflow binds secrets/vars')
  for (const name of refs) {
    assert.match(name, /^AIRINGCAL_STAGING_/, `unexpected non-staging reference: ${name}`)
  }
})

test('first step validates required staging config and exits 1 before any build (C8)', () => {
  const source = workflow()
  const steps = source.split('\n').filter((line) => line.startsWith('      - name:'))
  assert.ok(steps.length > 0)
  assert.match(steps[0]!, /Validate required staging config/)

  const validation = source.split('      - name:')[1] ?? ''
  assert.match(validation, /-z "\$\{!var:-\}"/, 'missing values are detected')
  assert.match(validation, /exit 1/, 'missing config exits before deploy')
  for (const required of [
    'AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN',
    'AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID',
    'AIRINGCAL_STAGING_WORKER_NAME',
    'AIRINGCAL_STAGING_PUBLIC_R2_BUCKET',
    'AIRINGCAL_STAGING_PUBLIC_BASE_URL',
  ]) {
    assert.match(validation, new RegExp(required), `${required} must be required`)
  }

  const order = [
    'Validate required staging config',
    'Checkout',
    'Install',
    'Materialize staging Wrangler config',
    'Deploy staging read worker',
  ].map((name) => source.indexOf(name))
  for (const [index, position] of order.entries()) {
    assert.notEqual(position, -1, `${order[index]} step is present`)
    if (index > 0) assert.ok(position > order[index - 1]!, `${order[index]} runs after ${order[index - 1]}`)
  }
})

test('deploy uses the materialized staging config, never the checked-in production one (C8)', () => {
  const source = workflow()
  const deploy = source.slice(source.indexOf('Deploy staging read worker'))
  assert.match(deploy, /wrangler deploy/)
  assert.match(deploy, /--config "\$RUNNER_TEMP\/wrangler-v3-read-staging\.toml"/)
  assert.match(deploy, /--name "\$AIRINGCAL_STAGING_WORKER_NAME"/)
  assert.match(source, /node scripts\/materialize-v3-read-staging-config\.mjs/)
  assert.doesNotMatch(
    source,
    /wrangler deploy\s+--config apps\/v3-read-worker\/wrangler\.toml/,
    'the checked-in config points at the production bucket',
  )
  assert.match(source, /secrets\.AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN/, 'staging token only')
  assert.doesNotMatch(source, /secrets\.CF_API_TOKEN|secrets\.CF_ACCOUNT_ID/, 'no repository-wide Cloudflare secrets')
})
