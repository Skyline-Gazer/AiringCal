import assert from 'node:assert/strict'
import test from 'node:test'
import { getCachedSubjectDetail, KVStorage, nextSubjectRefreshAt, packageBoundary, subjectDetailKey } from './index.ts'

class MockKV {
  values = new Map<string, unknown>()

  async get(key: string, type?: 'json') {
    const value = this.values.get(key)
    if (type === 'json') return value ?? null
    return value == null ? null : JSON.stringify(value)
  }

  async put(key: string, value: string) {
    this.values.set(key, JSON.parse(value))
  }

  async delete(key: string) {
    this.values.delete(key)
  }
}

test('storage package boundary exposes its package name', () => {
  assert.equal(packageBoundary, '@airing-cal/storage')
})

test('getCachedSubjectDetail returns fresh cached subject detail without upstream fetch', async () => {
  const kv = new MockKV()
  const storage = new KVStorage(kv)
  kv.values.set(subjectDetailKey(23080), {
    cached_at: 1000,
    subject: { id: 23080, name: 'Cached', total_episodes: 24 },
  })
  let calls = 0

  const subject = await getCachedSubjectDetail(storage, {
    getSubject: async () => {
      calls += 1
      return { id: 23080, name: 'Fresh', total_episodes: 25 }
    },
  }, 23080, 1000)

  assert.equal(calls, 0)
  assert.deepEqual(subject, { id: 23080, name: 'Cached', total_episodes: 24 })
})

test('getCachedSubjectDetail refreshes stale cache and keeps stale data when refresh fails', async () => {
  const kv = new MockKV()
  const storage = new KVStorage(kv)
  kv.values.set(subjectDetailKey(23080), {
    cached_at: 1000,
    subject: { id: 23080, name: 'Stale', total_episodes: 12 },
  })

  const refreshed = await getCachedSubjectDetail(storage, {
    getSubject: async () => ({ id: 23080, name: 'Fresh', total_episodes: 24 }),
  }, 23080, 1000 + 60 * 60 * 24 * 8)

  assert.deepEqual(refreshed, { id: 23080, name: 'Fresh', total_episodes: 24 })
  assert.deepEqual((kv.values.get(subjectDetailKey(23080)) as any).subject, refreshed)

  const fallback = await getCachedSubjectDetail(storage, {
    getSubject: async () => {
      throw new Error('upstream unavailable')
    },
  }, 23080, 1000 + 60 * 60 * 24 * 16)

  assert.deepEqual(fallback, { id: 23080, name: 'Fresh', total_episodes: 24 })
})

test('nextSubjectRefreshAt deterministically spreads subjects across six to eight days', () => {
  const cachedAt = 1_000_000
  const refreshTimes = Array.from({ length: 100 }, (_, index) => nextSubjectRefreshAt(index + 1, cachedAt))

  assert.equal(new Set(refreshTimes).size, 100)
  assert.equal(refreshTimes.every((at) => at >= cachedAt + 6 * 86400), true)
  assert.equal(refreshTimes.every((at) => at <= cachedAt + 8 * 86400), true)
  assert.equal(nextSubjectRefreshAt(42, cachedAt), nextSubjectRefreshAt(42, cachedAt))
})
