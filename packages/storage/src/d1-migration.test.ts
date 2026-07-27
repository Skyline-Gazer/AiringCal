import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const migrationPath = resolve(repositoryRoot, 'migrations/0001_d1_authoritative_state.sql')
const configPath = resolve(repositoryRoot, 'packages/storage/wrangler.d1-test.toml')
const wranglerPath = resolve(repositoryRoot, 'node_modules/.bin/wrangler')

const authoritativeTables = [
  'app_state',
  'collection_items',
  'subject_media',
  'sync_budget',
  'sync_budget_reservations',
  'sync_runs',
]

const expectedColumns: Record<string, string[]> = {
  app_state: ['key', 'value_json', 'updated_at'],
  collection_items: [
    'user_id', 'subject_id', 'collection_type', 'rate', 'tags_json', 'comment',
    'ep_status', 'vol_status', 'upstream_updated_at', 'subject_json', 'content_hash',
    'temperature', 'first_seen_at', 'changed_at', 'missing_since', 'deleted_at',
  ],
  subject_media: [
    'subject_id', 'detail_json', 'detail_hash', 'media_hash', 'nsfw',
    'source_image_common_url', 'source_image_large_url', 'r2_image_common_key',
    'r2_image_large_key', 'checked_at', 'next_refresh_at', 'retry_count',
    'retry_after', 'error_code',
  ],
  sync_budget: ['date', 'resource', 'reserved', 'consumed', 'updated_at'],
  sync_budget_reservations: [
    'reservation_id', 'date', 'resource', 'request_fingerprint', 'result_json',
    'submission_status', 'created_at', 'updated_at',
  ],
  sync_runs: [
    'instance_id', 'status', 'stage', 'generation', 'collection_count',
    'changed_count', 'missing_count', 'deleted_count', 'media_selected_count',
    'media_granted_count', 'input_hash', 'public_hash', 'error_code', 'started_at',
    'heartbeat_at', 'completed_at',
  ],
}

function runWrangler(args: string[]) {
  return spawnSync(wranglerPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
      WRANGLER_LOG_PATH: resolve(tmpdir(), `airing-cal-wrangler-${process.pid}.log`),
    },
  })
}

test('migration defines only the authoritative tables and reservation helper without secondary indexes or foreign keys', () => {
  const sql = readFileSync(migrationPath, 'utf8')

  for (const table of authoritativeTables) {
    assert.match(sql, new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${table}\\b`, 'i'))
  }
  assert.doesNotMatch(sql, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i)
  assert.doesNotMatch(sql, /\bFOREIGN\s+KEY\b|\bREFERENCES\b/i)
  assert.match(sql, /PRIMARY KEY\s*\(\s*user_id\s*,\s*subject_id\s*\)/i)
  assert.match(sql, /PRIMARY KEY\s*\(\s*date\s*,\s*resource\s*\)/i)
  assert.match(sql, /reservation_id\s+TEXT\s+PRIMARY KEY/i)
  assert.match(sql, /submission_status\s+TEXT[\s\S]*CHECK\s*\(\s*submission_status\s+IN\s*\(\s*'reserved'\s*,\s*'submitted'\s*,\s*'uncertain'\s*\)\s*\)/i)
  assert.doesNotMatch(sql, /\b(?:error_body|error_comment|upstream_body)\b/i)
})

test('migration applies idempotently to isolated local D1 and creates the exact application schema', () => {
  const persistTo = mkdtempSync(resolve(tmpdir(), 'airing-cal-d1-migration-'))
  const commonArgs = [
    'AIRING_CAL_D1',
    '--local',
    '--persist-to',
    persistTo,
    '--config',
    configPath,
  ]

  const firstApply = runWrangler(['d1', 'migrations', 'apply', ...commonArgs])
  assert.equal(firstApply.status, 0, firstApply.stderr || firstApply.stdout)

  const secondApply = runWrangler(['d1', 'migrations', 'apply', ...commonArgs])
  assert.equal(secondApply.status, 0, secondApply.stderr || secondApply.stdout)
  assert.match(`${secondApply.stdout}\n${secondApply.stderr}`, /No migrations to apply/i)

  const schemaResult = runWrangler([
    'd1',
    'execute',
    ...commonArgs,
    '--json',
    '--command',
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ])
  assert.equal(schemaResult.status, 0, schemaResult.stderr || schemaResult.stdout)

  const parsed = JSON.parse(schemaResult.stdout) as Array<{ results: Array<{ name: string }> }>
  const tables = parsed.flatMap((result) => result.results.map((row) => row.name))
  assert.deepEqual(tables, [...authoritativeTables, '_cf_METADATA', 'd1_migrations'].sort())

  for (const [table, columns] of Object.entries(expectedColumns)) {
    const columnResult = runWrangler([
      'd1',
      'execute',
      ...commonArgs,
      '--json',
      '--command',
      `SELECT name FROM pragma_table_info('${table}') ORDER BY cid`,
    ])
    assert.equal(columnResult.status, 0, columnResult.stderr || columnResult.stdout)
    const columnOutput = JSON.parse(columnResult.stdout) as Array<{ results: Array<{ name: string }> }>
    assert.deepEqual(columnOutput.flatMap((result) => result.results.map((row) => row.name)), columns)
  }
})
