import assert from 'node:assert/strict'
import test from 'node:test'
import { imageStatusKey, subjectDetailKey, subjectMetaKey } from '@airing-cal/storage'
import { buildCalendarSnapshotForPublish } from './snapshot-publish-hydration.ts'

const hash = 'a'.repeat(64)

class MockKV {
  values = new Map<string, unknown>()

  async get(key: string) {
    return this.values.get(key) ?? null
  }

  async put(key: string, value: unknown) {
    this.values.set(key, value)
  }

  async delete(key: string) {
    this.values.delete(key)
  }
}

test('buildCalendarSnapshotForPublish embeds cached image refs and image_status', async () => {
  const kv = new MockKV()
  kv.values.set(imageStatusKey(42), {
    subject_id: 42,
    common: {
      status: 'cached',
      hash,
      uri: `/image/${hash}`,
      r2_key: `images/${hash}/original`,
    },
    large: { status: 'failed', hash: null, uri: null, r2_key: null },
  })
  kv.values.set(subjectMetaKey(42), {
    subject_id: 42,
    exists: true,
    nsfw: true,
    checked_at: 1,
    expires_at: null,
    reason: 'subject_detail',
  })
  kv.values.set(subjectDetailKey(42), {
    cached_at: 1,
    subject: {
      id: 42,
      name: 'Detail name',
      eps: 12,
      total_episodes: 12,
      rating: { score: 7.5, rank: 100, total: 200 },
    },
  })

  const snapshot = await buildCalendarSnapshotForPublish([{
    weekday: { id: 1, cn: '一' },
    items: [{ id: 42, type: 2, name: 'Raw' }],
  }], kv as any)

  const item = snapshot[0]?.items[0]
  assert.equal(item?.images.common?.hash, hash)
  assert.equal(item?.image_status.common, 'cached')
  assert.equal(item?.image_status.large, 'failed')
  assert.equal(item?.name, 'Detail name')
  assert.equal(item?.eps, 12)
  assert.equal(item?.rating?.score, 7.5)
  assert.equal(item?.nsfw, true)
})
