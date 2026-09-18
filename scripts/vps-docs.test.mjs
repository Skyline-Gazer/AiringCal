import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const readDoc = (path) => {
  try {
    return read(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}
const docs = [
  'README.md',
  'docs/runbook/vps-data-plane.md',
  'deploy/vps/README.md',
  'docs/architecture/vps-data-plane.md',
].map(readDoc).join('\n')

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function required(text, value, label = value) {
  assert.match(text, new RegExp(escaped(value)), `documentation must include ${label}`)
}

test('documents the checked-in VPS environment and executable boundary', () => {
  const compose = read('deploy/vps/compose.yaml')
  const environment = new Set([
    'VPS_SYNC_IMAGE',
    ...[...compose.matchAll(/^      ([A-Z][A-Z0-9_]+):\s+\$\{([A-Z][A-Z0-9_]+)/gm)].map((match) => match[2]),
  ])
  for (const name of environment) required(docs, name, `environment variable ${name}`)

  const cli = read('apps/vps-sync/src/cli.ts')
  required(docs, 'sync', 'sync command')
  required(docs, '--mode=shadow|live', 'sync mode flag')
  required(docs, '--source=scheduled|manual', 'sync source flag')
  assert.match(cli, /Usage: sync \[--mode=shadow\|live\] \[--source=scheduled\|manual\]/)

  required(docs, 'applyMigrations', 'migration API')
  required(docs, 'createBackup', 'backup API')
  required(docs, 'restoreVerify', 'restore verification API')
  required(docs, 'migrate', 'migration operation name')
  required(docs, 'backup', 'backup operation name')
  required(docs, 'restore-verify', 'restore verification operation name')
  assert.match(docs, /(?:尚未|未|不).*?(?:migrate|backup|restore-verify).*?(?:命令|CLI)/s, 'docs must not claim unimplemented operation commands exist')
})

test('documents migrations, snapshot/backup keys, and terminal statuses', () => {
  const migrations = read('apps/vps-sync/src/postgres/migrations/0001_initial.sql')
  for (const [, name] of migrations.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)/g)) required(docs, name, `table ${name}`)
  for (const path of ['0001_initial.sql', '0002_media_component_state.sql', '0003_notification_failed.sql']) required(docs, path, `migration ${path}`)

  for (const key of [
    'public/manifest.json',
    'shadow/manifest.json',
    'snapshots/v1/',
    'backups/postgres/',
    'images/<hash>/original',
  ]) required(docs, key, `R2 key ${key}`)
  for (const status of ['running', 'success', 'no_change', 'partial', 'failed', 'skipped']) required(docs, status, `run status ${status}`)
  for (const event of ['sync_operation', 'notification_failed']) required(docs, event, `event ${event}`)
})

test('documents every Read Worker route and public route mapping', () => {
  const readWorker = read('apps/read-worker/src/index.ts')
  const readRoutes = new Set([
    ...[...readWorker.matchAll(/url\.pathname === '([^']+)'/g)].map((match) => match[1]),
    ...[...readWorker.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)].map((match) => match[1]),
  ])
  for (const route of readRoutes) required(docs, route, `Read Worker route ${route}`)

  const frontend = read('apps/frontend-worker/src/index.ts')
  const publicRoutes = new Set([
    ...[...frontend.matchAll(/url\.pathname === '([^']+)'/g)].map((match) => match[1]),
    ...[...frontend.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)].map((match) => match[1]),
  ].filter((route) => route.startsWith('/api/') || route.startsWith('/image/')))
  for (const route of publicRoutes) required(docs, route, `public route ${route}`)
})

test('documents frozen Cloudflare changes and deployment boundaries', () => {
  for (const change of ['harden-workflow-request-budget', 'adopt-d1-r2-incremental-sync', 'migrate-public-reads-from-kv']) {
    required(docs, change, `superseded change ${change}`)
  }
  assert.match(docs, /(?:frozen|superseded)/i)
  assert.match(docs, /(?:不|无|未).*自动.*(?:清理|部署|切换|切流)/s, 'docs must state that cleanup/deployment/cutover is not automatic')
  required(docs, 'VPS_SYNC_IMAGE', 'immutable deployment image')
  required(docs, '40 位', 'full SHA image requirement')
  required(docs, 'debug', 'manual debug image boundary')
})
