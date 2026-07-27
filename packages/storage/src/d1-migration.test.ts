import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

interface ExpectedColumn {
  name: string
  type: 'INTEGER' | 'TEXT'
  notnull: 0 | 1
  dflt_value: string | null
  pk: number
}

const column = (
  name: string,
  type: ExpectedColumn['type'],
  notnull: ExpectedColumn['notnull'],
  dflt_value: string | null = null,
  pk = 0,
): ExpectedColumn => ({ name, type, notnull, dflt_value, pk })

const expectedColumns: Record<string, ExpectedColumn[]> = {
  app_state: [
    column('key', 'TEXT', 1, null, 1),
    column('value_json', 'TEXT', 1),
    column('updated_at', 'INTEGER', 1),
  ],
  collection_items: [
    column('user_id', 'TEXT', 1, null, 1),
    column('subject_id', 'INTEGER', 1, null, 2),
    column('collection_type', 'INTEGER', 1),
    column('rate', 'INTEGER', 0),
    column('tags_json', 'TEXT', 1),
    column('comment', 'TEXT', 1),
    column('ep_status', 'INTEGER', 1),
    column('vol_status', 'INTEGER', 1),
    column('upstream_updated_at', 'TEXT', 0),
    column('subject_json', 'TEXT', 1),
    column('content_hash', 'TEXT', 1),
    column('state_version', 'INTEGER', 1, '1'),
    column('temperature', 'TEXT', 1),
    column('first_seen_at', 'INTEGER', 1),
    column('changed_at', 'INTEGER', 1),
    column('missing_since', 'INTEGER', 0),
    column('deleted_at', 'INTEGER', 0),
  ],
  subject_media: [
    column('subject_id', 'INTEGER', 0, null, 1),
    column('detail_json', 'TEXT', 0),
    column('detail_hash', 'TEXT', 0),
    column('media_hash', 'TEXT', 0),
    column('nsfw', 'INTEGER', 1, '0'),
    column('source_image_common_url', 'TEXT', 0),
    column('source_image_large_url', 'TEXT', 0),
    column('r2_image_common_key', 'TEXT', 0),
    column('r2_image_large_key', 'TEXT', 0),
    column('checked_at', 'INTEGER', 0),
    column('next_refresh_at', 'INTEGER', 0),
    column('retry_count', 'INTEGER', 1, '0'),
    column('retry_after', 'INTEGER', 0),
    column('error_code', 'TEXT', 0),
  ],
  sync_budget: [
    column('date', 'TEXT', 1, null, 1),
    column('resource', 'TEXT', 1, null, 2),
    column('reserved', 'INTEGER', 1, '0'),
    column('consumed', 'INTEGER', 1, '0'),
    column('updated_at', 'INTEGER', 1),
  ],
  sync_budget_reservations: [
    column('reservation_id', 'TEXT', 1, null, 1),
    column('date', 'TEXT', 1),
    column('resource', 'TEXT', 1),
    column('request_fingerprint', 'TEXT', 1),
    column('result_json', 'TEXT', 1),
    column('submission_status', 'TEXT', 1),
    column('created_at', 'INTEGER', 1),
    column('updated_at', 'INTEGER', 1),
  ],
  sync_runs: [
    column('instance_id', 'TEXT', 1, null, 1),
    column('status', 'TEXT', 1),
    column('stage', 'TEXT', 1),
    column('generation', 'INTEGER', 0),
    column('collection_count', 'INTEGER', 1, '0'),
    column('changed_count', 'INTEGER', 1, '0'),
    column('missing_count', 'INTEGER', 1, '0'),
    column('deleted_count', 'INTEGER', 1, '0'),
    column('media_selected_count', 'INTEGER', 1, '0'),
    column('media_granted_count', 'INTEGER', 1, '0'),
    column('input_hash', 'TEXT', 0),
    column('public_hash', 'TEXT', 0),
    column('error_code', 'TEXT', 0),
    column('started_at', 'INTEGER', 1),
    column('heartbeat_at', 'INTEGER', 1),
    column('completed_at', 'INTEGER', 0),
  ],
}

function runWrangler(args: string[], logPath: string) {
  return spawnSync(wranglerPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
      WRANGLER_LOG_PATH: logPath,
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
  assert.match(sql, /reservation_id\s+TEXT\s+NOT NULL\s+PRIMARY KEY/i)
  assert.match(sql, /temperature\s+TEXT\s+NOT NULL\s+CHECK\s*\(\s*temperature\s+IN\s*\(\s*'hot'\s*,\s*'cold'\s*\)\s*\)/i)
  assert.match(sql, /state_version\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1\s+CHECK\s*\(\s*state_version\s*>=\s*1\s*\)/i)
  assert.match(sql, /nsfw\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0\s+CHECK\s*\(\s*nsfw\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i)
  assert.match(sql, /reserved\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0\s+CHECK\s*\(\s*reserved\s*>=\s*0\s*\)/i)
  assert.match(sql, /consumed\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0\s+CHECK\s*\(\s*consumed\s*>=\s*0\s*\)/i)
  assert.equal((sql.match(/resource\s+TEXT\s+NOT NULL\s+CHECK\s*\(\s*resource\s+IN\s*\(\s*'media'\s*\)\s*\)/gi) ?? []).length, 2)
  assert.match(sql, /submission_status\s+TEXT[\s\S]*CHECK\s*\(\s*submission_status\s+IN\s*\(\s*'reserved'\s*,\s*'submitted'\s*,\s*'uncertain'\s*\)\s*\)/i)
  assert.doesNotMatch(sql, /\b(?:error_body|error_comment|upstream_body)\b/i)
})

test('migration applies idempotently to isolated local D1 and creates the exact application schema', (t) => {
  const persistTo = mkdtempSync(resolve(tmpdir(), 'airing-cal-d1-migration-'))
  const logPath = resolve(persistTo, 'wrangler.log')
  t.after(() => rmSync(persistTo, { recursive: true, force: true }))
  const commonArgs = [
    'AIRING_CAL_D1',
    '--local',
    '--persist-to',
    persistTo,
    '--config',
    configPath,
  ]

  const firstApply = runWrangler(['d1', 'migrations', 'apply', ...commonArgs], logPath)
  assert.equal(firstApply.status, 0, firstApply.stderr || firstApply.stdout)

  const secondApply = runWrangler(['d1', 'migrations', 'apply', ...commonArgs], logPath)
  assert.equal(secondApply.status, 0, secondApply.stderr || secondApply.stdout)
  assert.match(`${secondApply.stdout}\n${secondApply.stderr}`, /No migrations to apply/i)

  const schemaResult = runWrangler([
    'd1',
    'execute',
    ...commonArgs,
    '--json',
    '--command',
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ], logPath)
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
      `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`,
    ], logPath)
    assert.equal(columnResult.status, 0, columnResult.stderr || columnResult.stdout)
    const columnOutput = JSON.parse(columnResult.stdout) as Array<{ results: ExpectedColumn[] }>
    assert.deepEqual(columnOutput.flatMap((result) => result.results), columns)
  }

  for (const [table, statement] of [
    ['sync_runs', "INSERT INTO sync_runs (instance_id, status, stage, started_at, heartbeat_at) VALUES (NULL, 'queued', 'initialize', 1, 1)"],
    ['sync_budget_reservations', "INSERT INTO sync_budget_reservations (reservation_id, date, resource, request_fingerprint, result_json, submission_status, created_at, updated_at) VALUES (NULL, '2026-07-27', 'media', 'fingerprint', '{}', 'reserved', 1, 1)"],
    ['app_state', "INSERT INTO app_state (key, value_json, updated_at) VALUES (NULL, '{}', 1)"],
  ] as const) {
    const nullPrimaryKey = runWrangler([
      'd1',
      'execute',
      ...commonArgs,
      '--json',
      '--command',
      statement,
    ], logPath)
    assert.notEqual(nullPrimaryKey.status, 0, `${table} accepted a NULL primary key`)
    assert.match(`${nullPrimaryKey.stderr}\n${nullPrimaryKey.stdout}`, /NOT NULL constraint failed/i)
  }

  for (const stateVersion of [0, -1]) {
    const invalidRevision = runWrangler([
      'd1',
      'execute',
      ...commonArgs,
      '--json',
      '--command',
      `INSERT INTO collection_items (user_id, subject_id, collection_type, tags_json, comment, ep_status, vol_status, subject_json, content_hash, state_version, temperature, first_seen_at, changed_at) VALUES ('alice', ${100 + stateVersion}, 3, '[]', '', 0, 0, '{}', 'hash', ${stateVersion}, 'hot', 1, 1)`,
    ], logPath)
    assert.notEqual(invalidRevision.status, 0, `collection_items accepted state_version ${stateVersion}`)
    assert.match(`${invalidRevision.stderr}\n${invalidRevision.stdout}`, /CHECK constraint failed/i)
  }
})
