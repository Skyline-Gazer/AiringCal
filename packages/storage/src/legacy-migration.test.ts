import assert from 'node:assert/strict'
import test from 'node:test'
import type { SubjectMediaRow } from './d1-types.ts'
import {
  importLegacySubjectBatch,
  readLegacySubjectRecords,
  type LegacyMigrationD1,
} from './legacy-migration.ts'

class FakeStore implements LegacyMigrationD1 {
  rows = new Map<number, SubjectMediaRow>()
  puts = 0

  async getSubjectMediaRow(subjectId: number): Promise<SubjectMediaRow | undefined> {
    return this.rows.get(subjectId)
  }

  async putSubjectMediaRow(row: SubjectMediaRow): Promise<{ rowsWritten: number }> {
    this.rows.set(row.subject_id, { ...row })
    this.puts++
    return { rowsWritten: 1 }
  }
}

class FakeKv {
  values = new Map<string, unknown>()

  async get(key: string, _type: 'json'): Promise<unknown> {
    return this.values.get(key) ?? null
  }
}

function checkedRow(subjectId: number): SubjectMediaRow {
  return {
    subject_id: subjectId,
    detail_json: '{"name":"newer"}',
    detail_hash: 'a'.repeat(64),
    media_hash: 'b'.repeat(64),
    nsfw: 0,
    source_image_common_url: null,
    source_image_large_url: null,
    r2_image_common_key: null,
    r2_image_large_key: null,
    checked_at: 200,
    next_refresh_at: null,
    retry_count: 0,
    retry_after: null,
    error_code: null,
  }
}

test('import skips subjects with newer D1 state without extra writes', async () => {
  const store = new FakeStore()
  store.rows.set(1, checkedRow(1))
  const kv = new FakeKv()
  kv.values.set('subject:detail:1', { subject: { name: 'older' } })

  const summary = await importLegacySubjectBatch(store, kv, [1])

  assert.equal(summary.imported, 0)
  assert.equal(summary.skipped_existing, 1)
  assert.equal(store.puts, 0)
})

test('imports legacy detail, meta, and image refs into a fresh D1 row reusing R2 keys', async () => {
  const store = new FakeStore()
  const kv = new FakeKv()
  kv.values.set('subject:detail:7', {
    subject: {
      id: 7,
      name: 'X',
      nsfw: true,
      images: { common: 'https://x/c.jpg', large: 'https://x/l.jpg' },
    },
  })
  kv.values.set('subject:meta:7', {
    subject_id: 7,
    exists: true,
    nsfw: true,
    checked_at: 100,
    expires_at: null,
    reason: 'subject_detail',
  })
  kv.values.set('image:status:7', {
    common: { status: 'cached', hash: 'h1', uri: '/image/h1', r2_key: 'images/h1/original' },
    large: { status: 'cached', hash: 'h2', uri: '/image/h2', r2_key: 'images/h2/original' },
  })

  const summary = await importLegacySubjectBatch(store, kv, [7])

  assert.equal(summary.imported, 1)
  const row = store.rows.get(7)
  assert.ok(row)
  assert.equal(row.nsfw, 1)
  assert.equal(row.source_image_common_url, 'https://x/c.jpg')
  assert.equal(row.source_image_large_url, 'https://x/l.jpg')
  assert.equal(row.r2_image_common_key, 'images/h1/original')
  assert.equal(row.r2_image_large_key, 'images/h2/original')
  assert.equal(row.checked_at, 100)
  assert.equal(typeof row.detail_hash, 'string')
  assert.equal(typeof row.media_hash, 'string')
})

test('missing legacy keys are counted and do not block later subjects', async () => {
  const store = new FakeStore()
  const kv = new FakeKv()

  const summary = await importLegacySubjectBatch(store, kv, [1, 2])

  assert.equal(summary.missing_keys, 2)
  assert.equal(summary.imported, 0)
})

test('invalid legacy detail counts as errored without blocking later subjects', async () => {
  const store = new FakeStore()
  const kv = new FakeKv()
  kv.values.set('subject:detail:1', 'not-an-envelope')

  const summary = await importLegacySubjectBatch(store, kv, [1, 2])

  assert.equal(summary.errored, 1)
  assert.equal(summary.missing_keys, 1)
  assert.equal(store.puts, 0)
})

test('re-running the batch after a successful import skips without overwriting', async () => {
  const store = new FakeStore()
  const kv = new FakeKv()
  kv.values.set('subject:detail:5', { subject: { id: 5, name: 'Y' } })

  const first = await importLegacySubjectBatch(store, kv, [5])
  assert.equal(first.imported, 1)
  const detailHash = store.rows.get(5)?.detail_hash

  const second = await importLegacySubjectBatch(store, kv, [5])

  assert.equal(second.imported, 0)
  assert.equal(second.skipped_existing, 1)
  assert.equal(store.puts, 1)
  assert.equal(store.rows.get(5)?.detail_hash, detailHash)
})

test('readLegacySubjectRecords returns only present keys', async () => {
  const kv = new FakeKv()
  kv.values.set('subject:meta:3', { subject_id: 3, exists: true, nsfw: false, checked_at: 1, expires_at: null, reason: 'subject_detail' })

  const records = await readLegacySubjectRecords(kv, 3)

  assert.equal(records.subject_id, 3)
  assert.equal(records.detail, undefined)
  assert.ok(records.meta)
})
