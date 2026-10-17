import assert from 'node:assert/strict'
import test from 'node:test'
import { createBuilderSqliteD1Client } from './sqlite-d1-client.ts'
import { openBuilderDatabase } from './migrate.ts'

test('createBuilderSqliteD1Client supports subject_media upsert and select', async () => {
  const db = openBuilderDatabase(':memory:')
  const d1 = createBuilderSqliteD1Client(db)
  await d1.query(`INSERT INTO subject_media (
    subject_id, detail_json, detail_hash, media_hash, nsfw,
    source_image_common_url, source_image_large_url,
    r2_image_common_key, r2_image_large_key,
    checked_at, next_refresh_at, retry_count, retry_after, error_code
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    42, null, null, 'hash', 0,
    'https://lain.bgm.tv/c.jpg', null,
    'images/a/original', null,
    1, 2, 0, null, null,
  ])
  const rows = await d1.query('SELECT subject_id, r2_image_common_key FROM subject_media WHERE subject_id = ?', [42])
  assert.equal(rows[0]?.subject_id, 42)
  assert.equal(rows[0]?.r2_image_common_key, 'images/a/original')
})
