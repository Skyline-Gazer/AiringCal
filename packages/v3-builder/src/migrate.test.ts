import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILDER_SCHEMA_VERSION } from './schema.ts'
import { applyBuilderSchema, listUserTables, openBuilderDatabase } from './migrate.ts'
import { SqliteBuilderStateStore } from './sqlite-state.ts'

test('builder schema migration is idempotent and records version', () => {
  const db = openBuilderDatabase(':memory:')
  applyBuilderSchema(db, '2026-10-16T00:00:00.000Z')
  assert.deepEqual(listUserTables(db), [
    'builder_job_leases',
    'builder_kv',
    'sync_runs',
    'v3_schema_migrations',
  ])
  const version = db.prepare('SELECT version FROM v3_schema_migrations WHERE version = ?').get(BUILDER_SCHEMA_VERSION) as
    | { version: number }
    | undefined
  assert.equal(version?.version, BUILDER_SCHEMA_VERSION)
})

test('sqlite builder state store enforces exclusive job leases', async () => {
  const db = openBuilderDatabase(':memory:')
  const store = new SqliteBuilderStateStore(db)
  assert.equal(await store.acquireLease('daily-sync', 'runner-a', 120, 10_000), true)
  assert.equal(await store.acquireLease('daily-sync', 'runner-b', 120, 10_000), false)
  await store.setKv('last_success', '{"generation":1}', 10_000)
  assert.equal(await store.getKv('last_success'), '{"generation":1}')
  await store.releaseLease('daily-sync', 'runner-a')
  assert.equal(await store.acquireLease('daily-sync', 'runner-b', 120, 10_001), true)
})
