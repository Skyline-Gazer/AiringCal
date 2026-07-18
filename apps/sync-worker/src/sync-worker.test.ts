import assert from 'node:assert/strict'
import test from 'node:test'
import { subjectDetailKey } from '@airing-cal/storage'
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertV2MediaJob(value: unknown, subjectId: number, title: string, images: { common?: string; large?: string }) {
  const job = value as any
  assert.equal(job.version, 2)
  assert.match(job.job_id, new RegExp(`:${subjectId}$`))
  assert.equal(job.subject_id, subjectId)
  assert.equal(job.title, title)
  assert.deepEqual(job.components, ['detail', 'meta', 'image_common', 'image_large'])
  assert.deepEqual(job.images, images)
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
    if (text.endsWith('/v0/subjects/23080')) {
      return Response.json({
        id: 23080,
        type: 2,
        name: 'A Full',
        name_cn: 'A Full CN',
        summary: 'from subject detail',
        nsfw: false,
        date: '2026-07-02',
        eps: 12,
        total_episodes: 24,
        images: { common: 'https://img.example/detail-common.jpg', large: 'https://img.example/detail-large.jpg' },
        rating: { score: 8, rank: 0, total: 10 },
      })
    }
    throw new Error(`unexpected upstream fetch: ${text}`)
  }
  return { calls, fetch }
}

test('sync-worker does not expose public cron HTTP route', async () => {
  const response = await worker.fetch?.(new Request('https://sync.local/__cron/sync'), {} as any)

  assert.equal(response?.status, 404)
})

test('internal compare maps either account authentication failure without exposing tokens or fetching collections', async () => {
  for (const scenario of [
    { rejectedToken: 'source-secret', status: 401 },
    { rejectedToken: 'target-secret', status: 403 },
  ]) {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      assert.equal(url.endsWith('/v0/me'), true)
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === `Bearer ${scenario.rejectedToken}`) {
        return new Response('invalid token', { status: scenario.status })
      }
      return Response.json({ username: 'valid-user', id: 1 })
    }) as typeof globalThis.fetch

    try {
      const response = await worker.fetch?.(new Request('https://sync.local/internal/sync/compare', {
        method: 'POST',
        body: JSON.stringify({
          platformA: 'bgm',
          platformB: 'bgm',
          tokenA: 'source-secret',
          tokenB: 'target-secret',
        }),
      }), {} as any)
      const body = await response?.json() as any

      assert.equal(response?.status, scenario.status)
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'AUTHENTICATION_FAILED')
      assert.doesNotMatch(JSON.stringify(body), /source-secret|target-secret/)
      assert.equal(calls.some((url) => url.includes('/collections?')), false)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('internal compare maps dual authentication failure to a stable non-secret error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('invalid token', { status: 401 })) as typeof globalThis.fetch

  try {
    const response = await worker.fetch?.(new Request('https://sync.local/internal/sync/compare', {
      method: 'POST',
      body: JSON.stringify({
        platformA: 'bgm',
        platformB: 'bgm',
        tokenA: 'source-secret',
        tokenB: 'target-secret',
      }),
    }), {} as any)
    const body = await response?.json() as any

    assert.equal(response?.status, 401)
    assert.equal(body.error.code, 'AUTHENTICATION_FAILED')
    assert.doesNotMatch(JSON.stringify(body), /source-secret|target-secret/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internal compare maps either collection authentication failure without returning partial success', async () => {
  for (const scenario of [
    { rejectedToken: 'source-secret', status: 401 },
    { rejectedToken: 'target-secret', status: 403 },
  ]) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v0/me')) return Response.json({ username: 'valid-user', id: 1 })
      assert.equal(url.includes('/collections?'), true)
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === `Bearer ${scenario.rejectedToken}`) {
        return new Response('invalid token', { status: scenario.status })
      }
      return Response.json({ total: 0, data: [] })
    }) as typeof globalThis.fetch

    try {
      const response = await worker.fetch?.(new Request('https://sync.local/internal/sync/compare', {
        method: 'POST',
        body: JSON.stringify({
          platformA: 'bgm',
          platformB: 'bgm',
          tokenA: 'source-secret',
          tokenB: 'target-secret',
        }),
      }), {} as any)
      const body = await response?.json() as any

      assert.equal(response?.status, scenario.status)
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'AUTHENTICATION_FAILED')
      assert.doesNotMatch(JSON.stringify(body), /source-secret|target-secret/)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('internal compare maps dual collection authentication failure to a stable non-secret error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/v0/me')) return Response.json({ username: 'valid-user', id: 1 })
    assert.equal(url.includes('/collections?'), true)
    return new Response('invalid token', { status: 403 })
  }) as typeof globalThis.fetch

  try {
    const response = await worker.fetch?.(new Request('https://sync.local/internal/sync/compare', {
      method: 'POST',
      body: JSON.stringify({
        platformA: 'bgm',
        platformB: 'bgm',
        tokenA: 'source-secret',
        tokenB: 'target-secret',
      }),
    }), {} as any)
    const body = await response?.json() as any

    assert.equal(response?.status, 403)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'AUTHENTICATION_FAILED')
    assert.doesNotMatch(JSON.stringify(body), /source-secret|target-secret/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internal compare keeps network failures on the generic request failure path', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('network unavailable') }) as typeof globalThis.fetch

  try {
    const response = await worker.fetch?.(new Request('https://sync.local/internal/sync/compare', {
      method: 'POST',
      body: JSON.stringify({
        platformA: 'bgm',
        platformB: 'bgm',
        tokenA: 'source-secret',
        tokenB: 'target-secret',
      }),
    }), {} as any)
    const body = await response?.json() as any

    assert.equal(response?.status, 500)
    assert.equal(body.error.code, 'REQUEST_FAILED')
    assert.doesNotMatch(JSON.stringify(body), /source-secret|target-secret/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internal compare does not misclassify rate limits or upstream failures as authentication', async () => {
  for (const upstreamStatus of [429, 503]) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('temporary upstream failure', { status: upstreamStatus })) as typeof globalThis.fetch

    try {
      const response = await worker.fetch?.(new Request('https://sync.local/internal/sync/compare', {
        method: 'POST',
        body: JSON.stringify({
          platformA: 'bgm',
          platformB: 'bgm',
          tokenA: 'source-secret',
          tokenB: 'target-secret',
        }),
      }), {} as any)
      const body = await response?.json() as any

      assert.equal(response?.status, 500)
      assert.equal(body.error.code, 'REQUEST_FAILED')
      assert.doesNotMatch(JSON.stringify(body), /source-secret|target-secret/)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
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
    assert.equal((kv.values.get('sync:meta') as any).cron.last.status, 'ok')
    assert.equal((kv.values.get('sync:meta') as any).cron.last.source, 'scheduled')
    assert.equal(queueMessages.length, 1)
    assertV2MediaJob(queueMessages[0], 23080, 'A Full CN', {
      common: 'https://img.example/detail-common.jpg',
      large: 'https://img.example/detail-large.jpg',
    })
    assert.equal(upstream.calls.some((url) => url.includes('img.example')), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync marks refresh queued without changing image status for calendar-only subjects', async () => {
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
    if (text.endsWith('/v0/subjects/456080')) {
      return Response.json({
        id: 456080,
        type: 2,
        name: 'Calendar Only',
        name_cn: '日历限定',
        summary: 'from subject detail',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
        rating: { score: 7.1, rank: 0, total: 10 },
      })
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

    const refresh = kv.values.get('subject:refresh:456080') as any
    assert.equal(queueMessages.length, 1)
    assert.equal(refresh.subject_id, 456080)
    assert.equal(refresh.status, 'queued')
    assert.equal(kv.values.has('image:status:456080'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync enriches calendar episode totals from subject detail', async () => {
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
    if (text.endsWith('/v0/subjects/456080')) {
      return Response.json({
        id: 456080,
        type: 2,
        name: 'Calendar Only',
        name_cn: '日历限定',
        summary: 'from subject detail',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 24,
        images: { common: 'https://img.example/detail-common.jpg', large: 'https://img.example/detail-large.jpg' },
        rating: { score: 7.1, rank: 0, total: 10 },
      })
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

    const calendar = (kv.values.get('snapshot:calendar') as any[])[0]
    assert.equal(calendar.items[0].summary, 'from subject detail')
    assert.equal(calendar.items[0].eps, 12)
    assert.equal(calendar.items[0].total_episodes, 24)
    assertV2MediaJob(queueMessages[0], 456080, '日历限定', {
      common: 'https://img.example/detail-common.jpg',
      large: 'https://img.example/detail-large.jpg',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync still updates collection snapshots when subject detail enrichment fails', async () => {
  const kv = new MockKV()
  const existingCalendar = [{
    weekday: { en: 'Sun', cn: '星期日', ja: '日曜日', id: 7 },
    items: [{
      subject_id: 456080,
      id: 456080,
      name: 'Existing Full',
      name_cn: '已有完整条目',
      eps: 12,
      total_episodes: 24,
      rating: { score: 7.1, rank: 0, total: 10 },
    }],
  }]
  kv.values.set('snapshot:calendar', existingCalendar)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) {
      return Response.json({
        total: 1,
        data: [{
          subject_id: 23080,
          subject_type: 2,
          rate: 9,
          type: 2,
          comment: '',
          tags: [],
          ep_status: 12,
          vol_status: 0,
          updated_at: '2026-07-08T00:00:00.000Z',
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
        weekday: { en: 'Sun', cn: '星期日', ja: '日曜日', id: 7 },
        items: [{
          id: 456080,
          type: 2,
          name: 'Raw Calendar Only',
          name_cn: '原始日历条目',
          images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
        }],
      }])
    }
    if (text.endsWith('/v0/subjects/456080')) {
      return new Response('upstream unavailable', { status: 503 })
    }
    throw new Error(`unexpected upstream fetch: ${text}`)
  }) as typeof globalThis.fetch

  try {
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 5, 30, 4, 0, 0) } as any, {
      AIRING_CAL_KV: kv,
      MEDIA_QUEUE: { send: async () => {} },
      BANGUMI_TOKEN: 'token-a',
      BANGUMI_USERS: 'alice',
      SYNC_MODE: 'merge',
    } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)

    const watched = kv.values.get('snapshot:collections:watched') as any[]
    const meta = kv.values.get('sync:meta') as any

    assert.equal(watched[0].subject_id, 23080)
    assert.deepEqual(kv.values.get('snapshot:calendar'), existingCalendar)
    assert.equal(meta.cron.last.status, 'ok')
    assert.equal(meta.cron.last.warnings[0].stage, 'subject_details')
    assert.equal(meta.cron.last.warnings[0].subject_ids[0], 456080)
    assert.equal(meta.cron.last.warnings[0].errors[0].upstream_status, 503)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync reuses cached subject detail for calendar enrichment', async () => {
  const kv = new MockKV()
  kv.values.set(subjectDetailKey(456080), {
    cached_at: Math.floor(Date.now() / 1000),
    subject: {
      id: 456080,
      type: 2,
      name: 'Cached Calendar Only',
      name_cn: '缓存日历限定',
      summary: 'from subject detail cache',
      nsfw: false,
      date: '2026-07-01',
      eps: 12,
      total_episodes: 24,
      images: { common: 'https://img.example/cached-common.jpg', large: 'https://img.example/cached-large.jpg' },
      rating: { score: 7.1, rank: 0, total: 10 },
    },
  })
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
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
    if (text.endsWith('/v0/subjects/456080')) {
      return Response.json({
        id: 456080,
        type: 2,
        name: 'Calendar Only',
        name_cn: '日历限定',
        summary: 'from subject detail',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
        rating: { score: 7.1, rank: 0, total: 10 },
      })
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

    const calendar = (kv.values.get('snapshot:calendar') as any[])[0]
    assert.equal(calls.some((url) => url.includes('/v0/subjects/456080')), false)
    assert.equal(calendar.items[0].name_cn, '缓存日历限定')
    assert.equal(calendar.items[0].summary, 'from subject detail cache')
    assert.equal(calendar.items[0].total_episodes, 24)
    assertV2MediaJob(queueMessages[0], 456080, '缓存日历限定', {
      common: 'https://img.example/cached-common.jpg',
      large: 'https://img.example/cached-large.jpg',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync normalizes cached subject detail episode count aliases into calendar totals', async () => {
  const kv = new MockKV()
  kv.values.set(subjectDetailKey(456080), {
    cached_at: Math.floor(Date.now() / 1000),
    subject: {
      id: 456080,
      type: 2,
      name: 'Cached Calendar Only',
      name_cn: '缓存日历限定',
      summary: 'from subject detail cache',
      nsfw: false,
      date: '2026-07-01',
      eps_count: 12,
      images: { common: 'https://img.example/cached-common.jpg', large: 'https://img.example/cached-large.jpg' },
      rating: { score: 7.1, rank: 0, total: 10 },
    },
  })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
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
    if (text.endsWith('/v0/subjects/456080')) {
      return Response.json({
        id: 456080,
        type: 2,
        name: 'Calendar Only',
        name_cn: '日历限定',
        summary: 'from subject detail',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
        rating: { score: 7.1, rank: 0, total: 10 },
      })
    }
    throw new Error(`unexpected upstream fetch: ${text}`)
  }) as typeof globalThis.fetch

  try {
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 5, 30, 4, 0, 0) } as any, {
      AIRING_CAL_KV: kv,
      MEDIA_QUEUE: { send: async () => {} },
      BANGUMI_TOKEN: 'token-a',
      BANGUMI_USERS: 'alice',
      SYNC_MODE: 'merge',
    } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)

    const calendar = (kv.values.get('snapshot:calendar') as any[])[0]
    assert.equal(calls.some((url) => url.includes('/v0/subjects/456080')), false)
    assert.equal(calendar.items[0].eps, 12)
    assert.equal(calendar.items[0].total_episodes, 12)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync preserves queued refresh state when media queue send fails', async () => {
  const kv = new MockKV()
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
    if (text.endsWith('/v0/subjects/456080')) {
      return Response.json({
        id: 456080,
        type: 2,
        name: 'Calendar Only',
        name_cn: '日历限定',
        summary: 'from subject detail',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
        rating: { score: 7.1, rank: 0, total: 10 },
      })
    }
    throw new Error(`unexpected upstream fetch: ${text}`)
  }) as typeof globalThis.fetch

  try {
    await assert.rejects(
      worker.scheduled({ scheduledTime: Date.UTC(2026, 5, 30, 4, 0, 0) } as any, {
        AIRING_CAL_KV: kv,
        MEDIA_QUEUE: { send: async () => { throw new Error('queue unavailable') } },
        BANGUMI_TOKEN: 'token-a',
        BANGUMI_USERS: 'alice',
        SYNC_MODE: 'merge',
      } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any),
      /queue unavailable/,
    )

    const refresh = kv.values.get('subject:refresh:456080') as any
    assert.equal(refresh.status, 'queued')
    assert.equal(kv.values.has('image:status:456080'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync publishes V2 refresh job before later KV enrichment failures', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const originalGet = kv.get.bind(kv)
  kv.get = async (key: string, type?: 'json') => {
    if (key === 'subject:meta:456080') throw new Error('late kv failure')
    return originalGet(key, type)
  }
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
    if (text.endsWith('/v0/subjects/456080')) {
      return Response.json({
        id: 456080,
        type: 2,
        name: 'Calendar Only',
        name_cn: '日历限定',
        summary: 'from subject detail',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
        rating: { score: 7.1, rank: 0, total: 10 },
      })
    }
    throw new Error(`unexpected upstream fetch: ${text}`)
  }) as typeof globalThis.fetch

  try {
    await assert.rejects(
      worker.scheduled({ scheduledTime: Date.UTC(2026, 5, 30, 4, 0, 0) } as any, {
        AIRING_CAL_KV: kv,
        MEDIA_QUEUE: { send: async (message: unknown) => { queueMessages.push(message) } },
        BANGUMI_TOKEN: 'token-a',
        BANGUMI_USERS: 'alice',
        SYNC_MODE: 'merge',
      } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any),
      /late kv failure/,
    )

    assert.equal(queueMessages.length, 1)
    assertV2MediaJob(queueMessages[0], 456080, '日历限定', {
      common: 'https://img.example/calendar-common.jpg',
      large: 'https://img.example/calendar-large.jpg',
    })
    assert.equal((kv.values.get('subject:refresh:456080') as any).status, 'queued')
    assert.equal(kv.values.has('image:status:456080'), false)
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
    assert.equal(queueMessages.length, 1)
    assertV2MediaJob(queueMessages[0], 23080, 'A Full CN', {
      common: 'https://img.example/detail-common.jpg',
      large: 'https://img.example/detail-large.jpg',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync never republishes residual detail while a not-found tombstone is active', async () => {
  const kv = new MockKV()
  const now = Math.floor(Date.UTC(2026, 5, 30, 4, 0, 0) / 1000)
  kv.values.set(subjectDetailKey(23080), { cached_at: now - 1, subject: { id: 23080, name: 'Residual', name_cn: '残留', eps: 99, eps_count: 98, total_episodes: 97, rating: { score: 9.9 } } })
  kv.values.set('subject:meta:23080', { subject_id: 23080, exists: false, nsfw: true, checked_at: now - 1, expires_at: now + 86400, reason: 'not_found' })
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const upstream = mockFetch()
  globalThis.fetch = upstream.fetch as typeof globalThis.fetch
  Date.now = () => now * 1000
  try {
    await worker.scheduled({ scheduledTime: now * 1000 } as any, { AIRING_CAL_KV: kv, MEDIA_QUEUE: { send: async () => {} }, BANGUMI_TOKEN: 'token-a', BANGUMI_USERS: 'alice', SYNC_MODE: 'merge' } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)
    const collection = (kv.values.get('snapshot:collections:watching') as any[])[0]
    const calendar = (kv.values.get('snapshot:calendar') as any[])[0].items[0]
    assert.equal(collection.ep_status, 1)
    assert.notEqual(collection.eps, 99)
    assert.notEqual(collection.total_episodes, 97)
    assert.notEqual(calendar.eps, 99)
    assert.notEqual(calendar.eps_count, 98)
    assert.notEqual(calendar.total_episodes, 97)
    assert.notEqual(calendar.rating?.score, 9.9)
    assert.equal(upstream.calls.filter((url) => url.endsWith('/v0/subjects/23080')).length, 0)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync never republishes residual detail when a not-found tombstone expires', async () => {
  const kv = new MockKV()
  const now = Math.floor(Date.UTC(2026, 5, 30, 4, 0, 0) / 1000)
  kv.values.set(subjectDetailKey(23080), {
    cached_at: now - 1,
    subject: {
      id: 23080,
      name: 'Residual',
      name_cn: '残留',
      summary: 'deleted detail',
      date: '1999-01-01',
      eps: 99,
      eps_count: 98,
      total_episodes: 97,
      rating: { score: 9.9 },
    },
  })
  kv.values.set('subject:meta:23080', {
    subject_id: 23080,
    exists: false,
    nsfw: true,
    checked_at: now - 86400,
    expires_at: now,
    reason: 'not_found',
  })
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const upstream = mockFetch()
  globalThis.fetch = upstream.fetch as typeof globalThis.fetch
  Date.now = () => now * 1000
  try {
    await worker.scheduled({ scheduledTime: now * 1000 } as any, {
      AIRING_CAL_KV: kv,
      MEDIA_QUEUE: { send: async (message: unknown) => { queueMessages.push(message) } },
      BANGUMI_TOKEN: 'token-a',
      BANGUMI_USERS: 'alice',
      SYNC_MODE: 'merge',
    } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)

    const collection = (kv.values.get('snapshot:collections:watching') as any[])[0]
    const calendar = (kv.values.get('snapshot:calendar') as any[])[0].items[0]
    for (const entry of [collection, calendar]) {
      assert.notEqual(entry.name, 'Residual')
      assert.notEqual(entry.name_cn, '残留')
      assert.notEqual(entry.summary, 'deleted detail')
      assert.notEqual(entry.date, '1999-01-01')
      assert.notEqual(entry.eps, 99)
      assert.notEqual(entry.eps_count, 98)
      assert.notEqual(entry.total_episodes, 97)
      assert.notEqual(entry.rating?.score, 9.9)
    }
    assert.equal(queueMessages.length, 1)
    assertV2MediaJob(queueMessages[0], 23080, 'A CN', {
      common: 'https://img.example/common.jpg',
      large: 'https://img.example/large.jpg',
    })
    assert.equal(upstream.calls.filter((url) => url.endsWith('/v0/subjects/23080')).length, 0)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync suppresses legacy tombstone detail and queues immediate recovery', async () => {
  const kv = new MockKV()
  const now = Math.floor(Date.UTC(2026, 5, 30, 4, 0, 0) / 1000)
  kv.values.set(subjectDetailKey(23080), { cached_at: now - 1, subject: { id: 23080, name: 'Residual', eps: 99, rating: { score: 9.9 } } })
  kv.values.set('subject:meta:23080', { subject_id: 23080, exists: false, nsfw: true, checked_at: now - 100, reason: 'not_found_or_restricted' })
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const upstream = mockFetch()
  globalThis.fetch = upstream.fetch as typeof globalThis.fetch
  Date.now = () => now * 1000
  try {
    await worker.scheduled({ scheduledTime: now * 1000 } as any, {
      AIRING_CAL_KV: kv,
      MEDIA_QUEUE: { send: async (message: unknown) => { queueMessages.push(message) } },
      BANGUMI_TOKEN: 'token-a', BANGUMI_USERS: 'alice', SYNC_MODE: 'merge',
    } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)
    const collection = (kv.values.get('snapshot:collections:watching') as any[])[0]
    const calendar = (kv.values.get('snapshot:calendar') as any[])[0].items[0]
    assert.notEqual(collection.name, 'Residual')
    assert.notEqual(collection.eps, 99)
    assert.notEqual(collection.rating?.score, 9.9)
    assert.notEqual(calendar.name, 'Residual')
    assert.notEqual(calendar.eps, 99)
    assert.equal(upstream.calls.filter((url) => url.endsWith('/v0/subjects/23080')).length, 0)
    assert.equal(queueMessages.length, 1)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync queues expired collection-only tombstones for recovery but suppresses active TTLs', async () => {
  const now = Math.floor(Date.UTC(2026, 5, 30, 4, 0, 0) / 1000)
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  Date.now = () => now * 1000
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
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
            name: 'Collection only',
            name_cn: '仅收藏',
            images: { common: 'https://img.example/common.jpg', large: 'https://img.example/large.jpg' },
          },
        }],
      })
    }
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected upstream fetch: ${text}`)
  }) as typeof globalThis.fetch

  try {
    for (const scenario of [
      { label: 'active', expiresAt: now + 1, expectedJobs: 0 },
      { label: 'expired', expiresAt: now, expectedJobs: 1 },
    ]) {
      const kv = new MockKV()
      kv.values.set('subject:meta:23080', { subject_id: 23080, exists: false, nsfw: true, checked_at: now - 86400, expires_at: scenario.expiresAt, reason: 'not_found' })
      kv.values.set('image:status:23080', {
        common: { status: 'cached', hash: 'a'.repeat(64), uri: `/image/${'a'.repeat(64)}`, r2_key: `images/${'a'.repeat(64)}/original` },
        large: { status: 'cached', hash: 'b'.repeat(64), uri: `/image/${'b'.repeat(64)}`, r2_key: `images/${'b'.repeat(64)}/original` },
      })
      const queueMessages: unknown[] = []

      await worker.scheduled({ scheduledTime: now * 1000 } as any, {
        AIRING_CAL_KV: kv,
        MEDIA_QUEUE: { send: async (message: unknown) => { queueMessages.push(message) } },
        BANGUMI_TOKEN: 'token-a',
        BANGUMI_USERS: 'alice',
        SYNC_MODE: 'merge',
      } as any, { waitUntil: (promise: Promise<unknown>) => promise } as any)

      assert.equal(queueMessages.length, scenario.expectedJobs, scenario.label)
      if (scenario.expectedJobs) assertV2MediaJob(queueMessages[0], 23080, '仅收藏', { common: 'https://img.example/common.jpg', large: 'https://img.example/large.jpg' })
    }
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync loads collection cache state concurrently before publishing snapshots', async () => {
  const kv = new MockKV()
  const collectionCount = 30
  let activeCacheReads = 0
  let maxActiveCacheReads = 0
  const originalGet = kv.get.bind(kv)
  kv.get = async (key: string, type?: 'json') => {
    if (key.startsWith('subject:detail:') || key.startsWith('image:status:') || key.startsWith('subject:meta:')) {
      activeCacheReads += 1
      maxActiveCacheReads = Math.max(maxActiveCacheReads, activeCacheReads)
      await delay(5)
      try {
        return await originalGet(key, type)
      } finally {
        activeCacheReads -= 1
      }
    }
    return originalGet(key, type)
  }
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) {
      return Response.json({
        total: collectionCount,
        data: Array.from({ length: collectionCount }, (_, index) => {
          const id = 1000 + index
          return {
            subject_id: id,
            subject_type: 2,
            rate: 7,
            type: 3,
            comment: '',
            tags: [],
            ep_status: 1,
            vol_status: 0,
            updated_at: '2026-06-29T00:00:00.000Z',
            private: false,
            subject: {
              id,
              name: `Collection ${id}`,
              name_cn: `收藏 ${id}`,
              summary: '',
              date: '',
              eps: 12,
              total_episodes: 12,
              images: { common: `https://img.example/${id}-common.jpg`, large: `https://img.example/${id}-large.jpg` },
            },
          }
        }),
      })
    }
    if (text.endsWith('/calendar')) {
      return Response.json([{
        weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
        items: [{
          id: 900,
          type: 2,
          name: 'Calendar Only',
          name_cn: '日历限定',
          images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
          rating: { score: 0, rank: 0, total: 0 },
        }],
      }])
    }
    if (text.endsWith('/v0/subjects/900')) {
      return Response.json({
        id: 900,
        type: 2,
        name: 'Calendar Full',
        name_cn: '日历详情',
        summary: '',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
        rating: { score: 7.8, rank: 0, total: 12 },
      })
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

    assert.ok(kv.values.has('snapshot:summary'))
    assert.ok(maxActiveCacheReads > 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync uses subject detail as canonical collection display source', async () => {
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

    const collection = (kv.values.get('snapshot:collections:watching') as any[])[0]
    assert.equal(collection.name, 'A Full')
    assert.equal(collection.name_cn, 'A Full CN')
    assert.equal(collection.summary, 'from subject detail')
    assert.equal(collection.total_episodes, 24)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync refreshes subject details for calendar subjects only', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('/collections?')) {
      return Response.json({
        total: 1,
        data: [{
          subject_id: 111,
          subject_type: 2,
          rate: 7,
          type: 3,
          comment: '',
          tags: [],
          ep_status: 3,
          vol_status: 0,
          updated_at: '2026-06-29T00:00:00.000Z',
          private: false,
          subject: {
            id: 111,
            name: 'Collection Only',
            name_cn: '收藏限定',
            summary: '',
            date: '',
            eps: 12,
            total_episodes: 12,
            images: { common: 'https://img.example/collection-common.jpg', large: 'https://img.example/collection-large.jpg' },
            rating: { score: 6.5, rank: 0, total: 20 },
          },
        }],
      })
    }
    if (text.endsWith('/calendar')) {
      return Response.json([{
        weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
        items: [{
          id: 222,
          type: 2,
          name: 'Calendar Only',
          name_cn: '日历限定',
          summary: '',
          nsfw: false,
          date: '2026-07-01',
          eps: 12,
          total_episodes: 12,
          images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
          rating: { score: 0, rank: 0, total: 0 },
        }],
      }])
    }
    if (text.endsWith('/v0/subjects/222')) {
      return Response.json({
        id: 222,
        type: 2,
        name: 'Calendar Full',
        name_cn: '日历详情',
        summary: 'from calendar subject detail',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: 'https://img.example/calendar-detail-common.jpg', large: 'https://img.example/calendar-detail-large.jpg' },
        rating: { score: 7.8, rank: 0, total: 12 },
      })
    }
    if (text.endsWith('/v0/subjects/111')) {
      throw new Error('collection-only subject detail should not be fetched during scheduled sync')
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

    const collection = (kv.values.get('snapshot:collections:watching') as any[])[0]
    const calendar = (kv.values.get('snapshot:calendar') as any[])[0]
    assert.equal(collection.name_cn, '收藏限定')
    assert.equal(collection.total_episodes, 12)
    assert.equal(calendar.items[0].name_cn, '日历详情')
    assert.equal(calendar.items[0].rating.score, 7.8)
    assert.equal(calls.some((url) => url.endsWith('/v0/subjects/222')), true)
    assert.equal(calls.some((url) => url.endsWith('/v0/subjects/111')), false)
    assert.equal(queueMessages.length, 2)
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

test('operation check escapes HTML while preserving the JSON response contract', async () => {
  const kv = new MockKV()
  const operationId = 'malicious-0123456789abcdef'
  const maliciousOperation = {
    id: operationId,
    event: 'sync_operation',
    status: 'error',
    error: '</pre><script>alert("operation")</script>&',
  }
  kv.values.set(`sync:operation:${operationId}`, maliciousOperation)

  const html = await worker.fetch?.(new Request(`https://sync.local/internal/check/${operationId}`), {
    AIRING_CAL_KV: kv,
  } as any)
  const jsonResponse = await worker.fetch?.(new Request(`https://sync.local/internal/check/${operationId}`, {
    headers: { Accept: 'application/json' },
  }), { AIRING_CAL_KV: kv } as any)

  assert.equal(html?.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(html?.headers.get('x-frame-options'), 'DENY')
  assert.match(html?.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.match(html?.headers.get('content-security-policy') ?? '', /base-uri 'none'/)
  assert.doesNotMatch(await html?.text() ?? '', /<\/pre><script>/)
  assert.equal(jsonResponse?.headers.get('content-security-policy'), null)
  assert.deepEqual(await jsonResponse?.json(), { ok: true, operation: maliciousOperation })
})

test('internal sync apply reuses at most five items without refetching collections', async () => {
  const kv = new MockKV()
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.endsWith('/v0/users/-/collections/23080')) return Response.json({})
    if (text.includes('/collections/23080/episodes?')) {
      return Response.json({ total: 1, data: [{ episode: { id: 1 }, type: 2 }] })
    }
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    const apply = await worker.fetch?.(new Request('https://sync.local/internal/sync/apply', {
      method: 'POST',
      body: JSON.stringify({
        platformA: 'bgm',
        platformB: 'bgm',
        tokenA: 'source-secret-token',
        tokenB: 'target-secret-token',
        mode: 'partial',
        from: 'Source',
        to: 'Target',
        items: [{
          externalId: '23080',
          title: 'A CN',
          status: 'completed',
          progress: 1,
          totalEpisodes: 12,
          score: 9,
          platform: 'bgm',
        }],
      }),
    }), { AIRING_CAL_KV: kv } as any)

    assert.equal(apply?.status, 200)
    assert.equal(apply?.headers.get('Cache-Control'), 'no-store')
    assert.equal(calls.some((url) => url.endsWith('/v0/me') || url.includes('/collections?')), false)
    const operationPuts = kv.puts.filter((put) => put.key.startsWith('sync:operation:'))
    assert.deepEqual(operationPuts.map((put) => (put.value as any).status), ['running', 'ok'])
    assert.doesNotMatch(JSON.stringify(operationPuts), /source-secret-token|target-secret-token/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internal sync apply rejects more than five items before upstream work', async () => {
  const kv = new MockKV()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    throw new Error('unexpected fetch')
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
        items: Array.from({ length: 6 }, (_, index) => ({
          externalId: String(index + 1),
          title: `Anime ${index + 1}`,
          status: 'watching',
          progress: 1,
          totalEpisodes: 12,
          score: 7,
          platform: 'bgm',
        })),
      }),
    }), { AIRING_CAL_KV: kv } as any)

    assert.equal(apply?.status, 400)
    assert.equal(apply?.headers.get('Cache-Control'), 'no-store')
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('internal sync apply rejects missing tokens before upstream work', async () => {
  const kv = new MockKV()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    throw new Error('unexpected fetch')
  }) as typeof globalThis.fetch

  try {
    const apply = await worker.fetch?.(new Request('https://sync.local/internal/sync/apply', {
      method: 'POST',
      body: JSON.stringify({
        tokenA: '',
        tokenB: 'target-token',
        mode: 'partial',
        from: 'Source',
        to: 'Target',
        items: [{ externalId: '1', title: 'A', status: 'watching', progress: 1, totalEpisodes: 12, score: 7, platform: 'bgm' }],
      }),
    }), { AIRING_CAL_KV: kv } as any)

    assert.equal(apply?.status, 400)
    assert.equal(calls, 0)
    assert.equal(kv.puts.some((put) => JSON.stringify(put.value).includes('target-token')), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('scheduled sync skips non-four-hour cron ticks without upstream work', async () => {
  const kv = new MockKV()
  kv.values.set('sync:meta', {
    synced_at: 1782650300,
    cron: {
      last: {
        status: 'ok',
        source: 'scheduled',
        triggered_at: 1782650000,
        completed_at: 1782650300,
      },
    },
  })
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
    assert.equal((kv.values.get('sync:meta') as any).cron.last.status, 'ok')
    assert.equal((kv.values.get('sync:meta') as any).cron.last_skip.status, 'skipped')
    assert.equal((kv.values.get('sync:meta') as any).cron.last_skip.source, 'scheduled')
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
      messages: [{ body: { type: 'manual-sync' }, ack: () => {} }],
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
    assert.equal((kv.values.get('sync:meta') as any).cron.last.status, 'ok')
    assert.equal((kv.values.get('sync:meta') as any).cron.last.source, 'queue')
    assert.equal(queueMessages.length, 1)
    assert.equal(upstream.calls.some((url) => url.includes('/collections?')), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deploy queue trigger warms calendar without full collection sync', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:summary', { want: 0, watched: 0, watching: 1, on_hold: 0, dropped: 0, _total: 1 })
  kv.values.set('sync:meta', {
    synced_at: 1782650300,
    mode: 'merge',
    users: ['alice'],
  })
  const queueMessages: unknown[] = []
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('/collections?')) {
      throw new Error('deploy sync should not fetch collections')
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
    if (text.endsWith('/v0/subjects/456080')) {
      return Response.json({
        id: 456080,
        type: 2,
        name: 'Calendar Full',
        name_cn: '日历详情',
        summary: '',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
        rating: { score: 7.8, rank: 0, total: 12 },
      })
    }
    throw new Error(`unexpected upstream fetch: ${text}`)
  }) as typeof globalThis.fetch

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

    const meta = kv.values.get('sync:meta') as any
    const calendar = kv.values.get('snapshot:calendar') as any[]
    assert.equal(calls.some((url) => url.includes('/collections?')), false)
    assert.equal(calls.some((url) => url.endsWith('/calendar')), true)
    assert.equal(meta.synced_at, 1782650300)
    assert.equal(typeof meta.calendar_synced_at, 'number')
    assert.equal(meta.cron.last.status, 'ok')
    assert.equal(meta.cron.last.mode, 'deploy-calendar')
    assert.equal(calendar[0].items[0].name_cn, '日历详情')
    assert.equal(calendar[0].items[0].rating.score, 7.8)
    assert.equal(queueMessages.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('queue trigger records running status before long sync work finishes', async () => {
  const kv = new MockKV()
  const originalFetch = globalThis.fetch
  const upstream = mockFetch()
  globalThis.fetch = upstream.fetch as typeof globalThis.fetch

  try {
    await assert.rejects(
      worker.queue?.({
        messages: [{ body: { type: 'deploy-sync' }, ack: () => {} }],
      } as any, {
        AIRING_CAL_KV: kv,
        MEDIA_QUEUE: { send: async () => { throw new Error('queue unavailable') } },
        BANGUMI_TOKEN: 'token-a',
        BANGUMI_USERS: 'alice',
        SYNC_MODE: 'merge',
      } as any),
      /queue unavailable/,
    )

    const cronPuts = kv.puts
      .filter((put) => put.key === 'sync:meta')
      .map((put) => (put.value as any).cron?.last?.status)
      .filter(Boolean)
    assert.deepEqual(cronPuts, ['running', 'error'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
