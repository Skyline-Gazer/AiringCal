import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'

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

function mockFetch() {
  const calls: string[] = []
  const fetch = async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('/collections?')) {
      return Response.json({
        total: 1,
        data: [{
          subject_id: 23080,
          subject_type: 2,
          rate: 9,
          type: 3,
          comment: '',
          tags: [],
          ep_status: 1,
          vol_status: 0,
          updated_at: '2026-06-29T00:00:00.000Z',
          private: false,
          subject: {
            id: 23080,
            name: 'A',
            name_cn: 'A CN',
            summary: '',
            date: '',
            eps: 12,
            total_episodes: 12,
            images: { common: 'https://img.example/common.jpg', large: 'https://img.example/large.jpg' },
          },
        }],
      })
    }
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected upstream fetch: ${text}`)
  }
  return { calls, fetch }
}

test('sync-worker does not expose public cron HTTP route', async () => {
  const response = await worker.fetch?.(new Request('https://sync.local/__cron/sync'), {} as any)

  assert.equal(response?.status, 404)
})

test('scheduled sync writes new snapshot keys and enqueues media work without image downloads', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  const upstream = mockFetch()
  globalThis.fetch = upstream.fetch as typeof globalThis.fetch

  try {
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 5, 30, 4, 0, 0) } as any, {
      AIRING_CAL_KV: kv,
      MEDIA_QUEUE: { send: async (message: unknown) => { queueMessages.push(message) } },
      BANGUMI_TOKEN: 'token-a',
      BANGUMI_USERS: 'alice',
      SYNC_MODE: 'merge',
    } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)

    assert.ok(kv.values.has('snapshot:collections:watching'))
    assert.ok(kv.values.has('snapshot:calendar'))
    assert.ok(kv.values.has('snapshot:summary'))
    assert.ok(kv.values.has('sync:meta'))
    assert.equal(queueMessages.length, 1)
    assert.deepEqual(queueMessages[0], {
      subject_id: 23080,
      title: 'A CN',
      images: {
        common: 'https://img.example/common.jpg',
        large: 'https://img.example/large.jpg',
      },
    })
    assert.equal(upstream.calls.some((url) => url.includes('img.example')), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync skips non-four-hour cron ticks without upstream work', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount += 1
    throw new Error('unexpected fetch')
  }) as typeof globalThis.fetch

  try {
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 5, 30, 5, 0, 0) } as any, {
      AIRING_CAL_KV: kv,
      MEDIA_QUEUE: { send: async (message: unknown) => { queueMessages.push(message) } },
      BANGUMI_TOKEN: 'token-a',
      BANGUMI_USERS: 'alice',
      SYNC_MODE: 'merge',
    } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)

    assert.equal(fetchCount, 0)
    assert.equal(kv.values.size, 0)
    assert.equal(queueMessages.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
