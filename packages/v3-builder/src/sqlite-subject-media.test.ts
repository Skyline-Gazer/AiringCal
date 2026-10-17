import assert from 'node:assert/strict'
import test from 'node:test'
import type { SubjectMediaRow } from '@airing-cal/storage'
import { openBuilderDatabase, SqliteSubjectMediaStore } from '@airing-cal/v3-builder'

function row(overrides: Partial<SubjectMediaRow> = {}): SubjectMediaRow {
  return {
    subject_id: 7,
    detail_json: '{"subject":{"id":7}}',
    detail_hash: 'd'.repeat(64),
    media_hash: 'm'.repeat(64),
    nsfw: 0,
    source_image_common_url: 'https://lain.bgm.tv/a.jpg',
    source_image_large_url: null,
    r2_image_common_key: `images/${'a'.repeat(64)}/original`,
    r2_image_large_key: null,
    checked_at: 1_700_000_000,
    next_refresh_at: null,
    retry_count: 0,
    retry_after: null,
    error_code: null,
    ...overrides,
  }
}

test('SqliteSubjectMediaStore round-trips subject_media rows', async () => {
  const db = openBuilderDatabase(':memory:')
  try {
    const store = new SqliteSubjectMediaStore(db)
    assert.equal(await store.getSubjectMediaRow(7), undefined)

    assert.deepEqual(await store.putSubjectMediaRow(row()), { rowsWritten: 1 })
    assert.deepEqual(await store.getSubjectMediaRow(7), row())
    assert.equal(await store.getSubjectMediaRow(8), undefined)
  } finally {
    db.close()
  }
})

test('SqliteSubjectMediaStore keeps existing details when the incoming row has none', async () => {
  const db = openBuilderDatabase(':memory:')
  try {
    const store = new SqliteSubjectMediaStore(db)
    await store.putSubjectMediaRow(row({ nsfw: 1 }))
    await store.putSubjectMediaRow(row({
      detail_json: null,
      detail_hash: null,
      media_hash: 'n'.repeat(64),
      retry_count: 2,
      checked_at: 1_700_000_100,
    }))

    const stored = await store.getSubjectMediaRow(7)
    assert.equal(stored?.detail_json, '{"subject":{"id":7}}', 'legacy import must not erase a newer detail')
    assert.equal(stored?.detail_hash, 'd'.repeat(64))
    assert.equal(stored?.media_hash, 'n'.repeat(64))
    assert.equal(stored?.retry_count, 2)
    assert.equal(stored?.checked_at, 1_700_000_100)
  } finally {
    db.close()
  }
})
