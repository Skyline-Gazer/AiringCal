import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'

class MockKV {
  values = new Map<string, unknown>()
  puts: Array<{ key: string; value: unknown; options?: unknown }> = []

  async get(key: string, type?: 'json') {
    const value = this.values.get(key)
    if (type === 'json') return value ?? null
    return value == null ? null : JSON.stringify(value)
  }

  async put(key: string, value: string, options?: unknown) {
    this.puts.push({ key, value: JSON.parse(value), options })
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
    if (text.endsWith('/calendar')) {
      return Response.json([{
        weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
        items: [{
          id: 23080,
          type: 2,
          name: 'A',
          name_cn: 'A CN',
          summary: '',
          nsfw: false,
          date: '2026-07-01',
          eps: 12,
          total_episodes: 12,
          images: { common: 'https://img.example/common.jpg', large: 'https://img.example/large.jpg' },
          rating: { score: 0, rank: 0, total: 0 },
        }],
      }])
    }
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
      subject_meta: true,
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

test('scheduled sync marks queued image status before media-worker caches calendar-only subjects', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) {
      return Response.json({ total: 0, data: [] })
    }
    if (text.endsWith('/calendar')) {
      return Response.json([{
        weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
        items: [{
          id: 456080,
          type: 2,
          name: 'Calendar Only',
          name_cn: '日历限定',
          images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
          rating: { score: 0, rank: 0, total: 0 },
        }],
      }])
    }
    throw new Error(`unexpected upstream fetch: ${text}`)
  }) as typeof globalThis.fetch

  try {
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 5, 30, 4, 0, 0) } as any, {
      AIRING_CAL_KV: kv,
      MEDIA_QUEUE: { send: async (message: unknown) => { queueMessages.push(message) } },
      BANGUMI_TOKEN: 'token-a',
      BANGUMI_USERS: 'alice',
      SYNC_MODE: 'merge',
    } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)

    const status = kv.values.get('image:status:456080') as any
    assert.equal(queueMessages.length, 1)
    assert.equal(status.subject_id, 456080)
    assert.equal(status.title, '日历限定')
    assert.equal(status.common.status, 'queued')
    assert.equal(status.large.status, 'queued')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync enriches collection and calendar snapshots from existing media cache', async () => {
  const kv = new MockKV()
  kv.values.set('image:status:23080', {
    common: { status: 'cached', hash: 'a'.repeat(64), uri: `/image/${'a'.repeat(64)}`, r2_key: `images/${'a'.repeat(64)}/original` },
    large: { status: 'cached', hash: 'b'.repeat(64), uri: `/image/${'b'.repeat(64)}`, r2_key: `images/${'b'.repeat(64)}/original` },
  })
  kv.values.set('subject:meta:23080', { subject_id: 23080, exists: true, nsfw: true, checked_at: 1, reason: 'subject_detail' })
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

    const collection = (kv.values.get('snapshot:collections:watching') as any[])[0]
    const calendar = (kv.values.get('snapshot:calendar') as any[])[0]
    assert.equal(collection.images.common.hash, 'a'.repeat(64))
    assert.equal(collection.images.large.hash, 'b'.repeat(64))
    assert.equal(collection.nsfw, true)
    assert.equal(calendar.items[0].images.common.hash, 'a'.repeat(64))
    assert.equal(calendar.items[0].nsfw, true)
    assert.deepEqual(queueMessages, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internal sync apply persists a 24h operation log and check returns it', async () => {
  const kv = new MockKV()
  const originalFetch = globalThis.fetch
  const responses = [
    { match: '/v0/me', body: { username: 'source-user', id: 1 } },
    { match: '/collections?', body: { total: 1, data: [{
      subject_id: 23080,
      subject_type: 2,
      rate: 9,
      type: 2,
      comment: '',
      tags: [],
      ep_status: 1,
      vol_status: 0,
      updated_at: '2026-06-29T00:00:00.000Z',
      private: false,
      subject: { id: 23080, name: 'A', name_cn: 'A CN', summary: '', date: '', eps: 12, total_episodes: 12 },
    }] } },
    { match: '/collections/23080', body: {} },
    { match: '/collections/23080/episodes?limit=1000&offset=0', body: { total: 1, data: [{ episode: { id: 1 }, type: 2 }] } },
    { match: '/collections/23080/episodes?limit=1000&offset=0', body: { total: 1, data: [{ episode: { id: 1 }, type: 1 }] } },
    { match: '/collections/23080/episodes', body: {} },
  ]
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url)
    const index = responses.findIndex((response) => text.includes(response.match))
    const response = index >= 0 ? responses.splice(index, 1)[0] : undefined
    if (!response) throw new Error(`unexpected fetch ${text} ${init?.method ?? 'GET'}`)
    return Response.json(response.body)
  }) as typeof globalThis.fetch

  try {
    const apply = await worker.fetch?.(new Request('https://sync.local/internal/sync/apply', {
      method: 'POST',
      body: JSON.stringify({
        platformA: 'bgm',
        platformB: 'bgm',
        tokenA: 'source-token',
        tokenB: 'target-token',
        mode: 'partial',
        from: 'Source',
        to: 'Target',
        subject_ids: ['23080'],
        baseline: [{ externalId: '23080', status: 'watching', score: 7, progress: 0, totalEpisodes: 12 }],
      }),
    }), { AIRING_CAL_KV: kv } as any)
    const operationId = apply?.headers.get('X-Sync-Operation-Id') ?? ''

    assert.equal(apply?.status, 200)
    assert.match(operationId, /^[0-9a-z]+-[0-9a-f]{16}$/i)
    assert.deepEqual(kv.puts.find((put) => put.key === `sync:operation:${operationId}`)?.options, { expirationTtl: 86400 })
    const check = await worker.fetch?.(new Request(`https://sync.local/internal/check/${operationId}`, {
      headers: { Accept: 'application/json' },
    }), { AIRING_CAL_KV: kv } as any)
    const body = await check?.json() as any
    assert.equal(body.ok, true)
    assert.equal(body.operation.id, operationId)
    assert.equal(body.operation.items[0].externalId, '23080')
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

test('queue trigger runs sync immediately without cron hour gating', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  const upstream = mockFetch()
  globalThis.fetch = upstream.fetch as typeof globalThis.fetch

  try {
    await worker.queue?.({
      messages: [{ body: { type: 'deploy-sync' }, ack: () => {} }],
    } as any, {
      AIRING_CAL_KV: kv,
      MEDIA_QUEUE: { send: async (message: unknown) => { queueMessages.push(message) } },
      BANGUMI_TOKEN: 'token-a',
      BANGUMI_USERS: 'alice',
      SYNC_MODE: 'merge',
    } as any)

    assert.ok(kv.values.has('snapshot:collections:watching'))
    assert.ok(kv.values.has('snapshot:calendar'))
    assert.ok(kv.values.has('sync:meta'))
    assert.equal(queueMessages.length, 1)
    assert.equal(upstream.calls.some((url) => url.includes('/collections?')), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
