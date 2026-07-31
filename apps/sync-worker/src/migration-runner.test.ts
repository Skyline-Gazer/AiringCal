import assert from 'node:assert/strict'
import test from 'node:test'
import {
  migrateLegacyCursorKey,
  migrateLegacySummaryKey,
  type CollectionRow,
  type MigrationCursorV1,
  type SubjectMediaRow,
} from '@airing-cal/storage'
import {
  runLegacyMigration,
  type MigrationRunnerD1,
} from './migration-runner.ts'

const now = 1_785_104_400

function subjectRow(subjectId: number): CollectionRow {
  return {
    user_id: 'u1',
    subject_id: subjectId,
    collection_type: 2,
    rate: null,
    tags_json: '[]',
    comment: '',
    ep_status: 0,
    vol_status: 0,
    upstream_updated_at: null,
    subject_json: '{}',
    content_hash: 'a'.repeat(64),
    state_version: 1,
    temperature: 'cold',
    first_seen_at: now,
    changed_at: now,
    missing_since: null,
    deleted_at: null,
  }
}

class FakeMigrationD1 implements MigrationRunnerD1 {
  rows: CollectionRow[] = []
  media = new Map<number, SubjectMediaRow>()
  appState = new Map<string, unknown>()
  puts = 0

  async listCollectionRows(): Promise<CollectionRow[]> {
    return this.rows
  }

  async getSubjectMediaRow(subjectId: number): Promise<SubjectMediaRow | undefined> {
    return this.media.get(subjectId)
  }

  async putSubjectMediaRow(row: SubjectMediaRow): Promise<{ rowsWritten: number }> {
    this.media.set(row.subject_id, { ...row })
    this.puts++
    return { rowsWritten: 1 }
  }

  async getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined> {
    const value = this.appState.get(key)
    return value === undefined ? undefined : decode(value)
  }

  async putAppStateIfNewer<T>(key: string, value: T, _version: number): Promise<boolean> {
    this.appState.set(key, structuredClone(value))
    return true
  }
}

class FakeKv {
  values = new Map<string, unknown>()
  rejectSubjectId: number | null = null

  async get(key: string, _type: 'json'): Promise<unknown> {
    const subjectId = Number(key.match(/^subject:detail:(\d+)$/)?.[1] ?? NaN)
    if (this.rejectSubjectId !== null && subjectId === this.rejectSubjectId) {
      throw new Error(`kv unavailable for ${key}`)
    }
    return this.values.get(key) ?? null
  }
}

function seededKv(count: number): FakeKv {
  const kv = new FakeKv()
  for (let id = 1; id <= count; id++) {
    kv.values.set(`subject:detail:${id}`, { subject: { id, name: `s${id}` } })
  }
  return kv
}

test('runner resumes from the persisted cursor after an interrupted batch', async () => {
  const store = new FakeMigrationD1()
  store.rows = Array.from({ length: 120 }, (_, index) => subjectRow(index + 1))
  const kv = seededKv(120)
  store.appState.set(migrateLegacyCursorKey(), {
    last_subject_id: 100,
    batch_index: 1,
    updated_at: now,
  } satisfies MigrationCursorV1)

  const summary = await runLegacyMigration(store, kv, now + 1)

  assert.equal(summary.imported, 20)
  assert.equal(store.puts, 20)
  const cursor = store.appState.get(migrateLegacyCursorKey()) as MigrationCursorV1
  assert.equal(cursor.last_subject_id, 120)
})

test('re-running after completion imports nothing and stays idempotent', async () => {
  const store = new FakeMigrationD1()
  store.rows = Array.from({ length: 50 }, (_, index) => subjectRow(index + 1))
  const kv = seededKv(50)

  const first = await runLegacyMigration(store, kv, now)
  assert.equal(first.imported, 50)
  const second = await runLegacyMigration(store, kv, now + 1)

  assert.equal(second.imported, 0)
  assert.equal(store.puts, 50)
})

test('empty collection set performs no batches', async () => {
  const store = new FakeMigrationD1()

  const summary = await runLegacyMigration(store, new FakeKv(), now)

  assert.equal(summary.imported, 0)
  assert.equal(summary.missing_keys, 0)
  assert.equal(store.puts, 0)
})

test('a subject that throws is counted as errored while later subjects in the batch keep importing', async () => {
  const store = new FakeMigrationD1()
  store.rows = Array.from({ length: 120 }, (_, index) => subjectRow(index + 1))
  const kv = seededKv(120)
  kv.rejectSubjectId = 60

  const summary = await runLegacyMigration(store, kv, now)

  assert.equal(summary.imported, 119)
  assert.equal(summary.errored, 1)
  const cursor = store.appState.get(migrateLegacyCursorKey()) as MigrationCursorV1
  assert.equal(cursor.last_subject_id, 120)
})

test('runner persists a summary even when nothing is pending', async () => {
  const store = new FakeMigrationD1()

  await runLegacyMigration(store, new FakeKv(), now)

  assert.ok(store.appState.has(migrateLegacySummaryKey()))
})
