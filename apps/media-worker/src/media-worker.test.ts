import assert from 'node:assert/strict'
import test from 'node:test'
import { subjectDetailKey, subjectRefreshKey } from '@airing-cal/storage'
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

class MockR2 {
  writes: Array<{ key: string; value: ArrayBuffer; options: any }> = []
  async put(key: string, value: ArrayBuffer, options: any) {
    this.writes.push({ key, value, options })
    return {}
  }
  async get() {
    return null
  }
}

function batch(body: unknown) {
  return {
    messages: [{ body, ack: () => {}, retry: () => {} }],
  }
}

function trackedBatch(body: unknown, attempts = 1) {
  const state = { acked: 0, retries: [] as Array<{ delaySeconds?: number }> }
  return {
    state,
    batch: {
      messages: [{
        body,
        attempts,
        ack: () => { state.acked++ },
        retry: (options?: { delaySeconds?: number }) => { state.retries.push(options ?? {}) },
      }],
    },
  }
}

test('media-worker downloads common and large images, writes R2 and cache status', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('common.jpg')) return new Response('common-bytes', { headers: { 'content-type': 'image/jpeg' } })
    if (text.includes('large.jpg')) return new Response('large-bytes', { headers: { 'content-type': 'image/png' } })
    if (text.includes('/v0/subjects/23080')) return Response.json({
      id: 23080,
      nsfw: true,
      images: { common: 'https://img.example/common.jpg', large: 'https://img.example/large.jpg' },
    })
    throw new Error(`unexpected fetch ${text}`)
  }

  try {
    await worker.queue(batch({
      subject_id: 23080,
      title: 'A CN',
      images: { common: 'https://img.example/common.jpg', large: 'https://img.example/large.jpg' },
    }) as any, {
      AIRING_CAL_KV: kv,
      AIRING_CAL_R2: r2,
    } as any)

    assert.equal(r2.writes.length, 2)
    assert.equal(r2.writes.every((write) => /^images\/[0-9a-f]{64}\/original$/.test(write.key)), true)
    const status = kv.values.get('image:status:23080') as any
    assert.equal(status.common.status, 'cached')
    assert.equal(status.large.status, 'cached')
    assert.match(status.common.hash, /^[0-9a-f]{64}$/)
    assert.equal(status.common.uri, `/image/${status.common.hash}`)
    assert.equal(status.common.source_url, 'https://img.example/common.jpg')
    assert.equal(status.large.source_url, 'https://img.example/large.jpg')
    assert.equal(kv.values.has(`image:index:${status.common.hash}`), true)
    assert.deepEqual(kv.values.get('subject:meta:23080'), {
      subject_id: 23080,
      exists: true,
      nsfw: true,
      checked_at: status.subject_checked_at,
      reason: 'subject_detail',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker uses subject detail images instead of calendar job image URLs', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  kv.values.set('image:status:23080', {
    subject_id: 23080,
    title: 'A CN',
    common: { status: 'cached', hash: 'a'.repeat(64), uri: `/image/${'a'.repeat(64)}`, r2_key: `images/${'a'.repeat(64)}/original`, queued_at: 1, cached_at: 1, last_error: null, source_url: 'https://img.example/calendar-common.jpg' },
    large: { status: 'missing_source', hash: null, uri: null, r2_key: null, queued_at: null, cached_at: null, last_error: null },
    subject_checked_at: 1,
  })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('/v0/subjects/23080')) return Response.json({
      id: 23080,
      nsfw: false,
      images: {
        common: 'https://img.example/detail-common.jpg',
        large: 'https://img.example/detail-large.jpg',
      },
    })
    if (text.includes('detail-common.jpg')) return new Response('detail-common-bytes', { headers: { 'content-type': 'image/jpeg' } })
    if (text.includes('detail-large.jpg')) return new Response('detail-large-bytes', { headers: { 'content-type': 'image/png' } })
    throw new Error(`unexpected fetch ${text}`)
  }

  try {
    await worker.queue(batch({
      subject_id: 23080,
      title: 'A CN',
      images: {
        common: 'https://img.example/calendar-common.jpg',
        large: 'https://img.example/calendar-large.jpg',
      },
    }) as any, {
      AIRING_CAL_KV: kv,
      AIRING_CAL_R2: r2,
    } as any)

    const status = kv.values.get('image:status:23080') as any
    assert.equal(calls.some((url) => url.includes('calendar-common.jpg')), false)
    assert.equal(calls.some((url) => url.includes('calendar-large.jpg')), false)
    assert.equal(status.common.status, 'cached')
    assert.notEqual(status.common.hash, 'a'.repeat(64))
    assert.equal(status.common.source_url, 'https://img.example/detail-common.jpg')
    assert.equal(status.large.source_url, 'https://img.example/detail-large.jpg')
    assert.equal(r2.writes.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker reuses cached subject detail without fetching subject API', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  kv.values.set(subjectDetailKey(23080), {
    cached_at: Math.floor(Date.now() / 1000),
    subject: {
      id: 23080,
      nsfw: false,
      images: {
        common: 'https://img.example/cached-common.jpg',
        large: 'https://img.example/cached-large.jpg',
      },
    },
  })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('cached-common.jpg')) return new Response('cached-common-bytes', { headers: { 'content-type': 'image/jpeg' } })
    if (text.includes('cached-large.jpg')) return new Response('cached-large-bytes', { headers: { 'content-type': 'image/png' } })
    throw new Error(`unexpected fetch ${text}`)
  }

  try {
    await worker.queue(batch({
      subject_id: 23080,
      title: 'A CN',
      images: {
        common: 'https://img.example/calendar-common.jpg',
        large: 'https://img.example/calendar-large.jpg',
      },
    }) as any, {
      AIRING_CAL_KV: kv,
      AIRING_CAL_R2: r2,
    } as any)

    const status = kv.values.get('image:status:23080') as any
    assert.equal(calls.some((url) => url.includes('/v0/subjects/23080')), false)
    assert.equal(calls.some((url) => url.includes('calendar-common.jpg')), false)
    assert.equal(status.common.source_url, 'https://img.example/cached-common.jpg')
    assert.equal(status.large.source_url, 'https://img.example/cached-large.jpg')
    assert.deepEqual(kv.values.get('subject:meta:23080'), {
      subject_id: 23080,
      exists: true,
      nsfw: false,
      checked_at: status.subject_checked_at,
      reason: 'subject_detail',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker treats subject detail 404 as restricted NSFW', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/v0/subjects/23080')) return new Response('Not found', { status: 404 })
    throw new Error(`unexpected fetch ${text}`)
  }

  try {
    await worker.queue(batch({
      subject_id: 23080,
      title: 'A CN',
      images: { common: 'https://img.example/common.jpg' },
    }) as any, {
      AIRING_CAL_KV: kv,
      AIRING_CAL_R2: r2,
    } as any)

    const meta = kv.values.get('subject:meta:23080') as any
    assert.equal(meta.exists, false)
    assert.equal(meta.nsfw, true)
    assert.equal(meta.reason, 'not_found_or_restricted')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker preserves existing cached image status when a later download fails', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  kv.values.set('image:status:23080', {
    subject_id: 23080,
    title: 'A CN',
    common: { status: 'cached', hash: 'a'.repeat(64), uri: `/image/${'a'.repeat(64)}`, r2_key: `images/${'a'.repeat(64)}/original`, queued_at: 1, cached_at: 1, last_error: null },
    large: { status: 'missing_source', hash: null, uri: null, r2_key: null, queued_at: null, cached_at: null, last_error: null },
    subject_checked_at: 1,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('common.jpg')) return new Response('bad gateway', { status: 502 })
    if (text.includes('/v0/subjects/23080')) return Response.json({
      id: 23080,
      nsfw: false,
      images: { common: 'https://img.example/common.jpg' },
    })
    throw new Error(`unexpected fetch ${text}`)
  }

  try {
    await worker.queue(batch({
      subject_id: 23080,
      title: 'A CN',
      images: { common: 'https://img.example/common.jpg' },
      subject_meta: true,
    }) as any, {
      AIRING_CAL_KV: kv,
      AIRING_CAL_R2: r2,
    } as any)

    const status = kv.values.get('image:status:23080') as any
    assert.equal(status.common.status, 'cached')
    assert.equal(status.common.hash, 'a'.repeat(64))
    assert.equal(status.large.status, 'missing_source')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker skips downloading image sizes that are already cached', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  kv.values.set('image:status:23080', {
    subject_id: 23080,
    title: 'A CN',
    common: { status: 'cached', hash: 'a'.repeat(64), uri: `/image/${'a'.repeat(64)}`, r2_key: `images/${'a'.repeat(64)}/original`, queued_at: 1, cached_at: 1, last_error: null, source_url: 'https://img.example/common.jpg' },
    large: { status: 'missing_source', hash: null, uri: null, r2_key: null, queued_at: null, cached_at: null, last_error: null },
    subject_checked_at: 1,
  })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('large.jpg')) return new Response('large-bytes', { headers: { 'content-type': 'image/png' } })
    if (text.includes('/v0/subjects/23080')) return Response.json({
      id: 23080,
      nsfw: false,
      images: { common: 'https://img.example/common.jpg', large: 'https://img.example/large.jpg' },
    })
    throw new Error(`unexpected fetch ${text}`)
  }

  try {
    await worker.queue(batch({
      subject_id: 23080,
      title: 'A CN',
      images: { common: 'https://img.example/common.jpg', large: 'https://img.example/large.jpg' },
      subject_meta: true,
    }) as any, {
      AIRING_CAL_KV: kv,
      AIRING_CAL_R2: r2,
    } as any)

    const status = kv.values.get('image:status:23080') as any
    assert.equal(calls.some((url) => url.includes('common.jpg')), false)
    assert.equal(calls.some((url) => url.includes('large.jpg')), true)
    assert.equal(status.common.hash, 'a'.repeat(64))
    assert.equal(status.large.status, 'cached')
    assert.equal(r2.writes.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker processes subject metadata without image sources', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/v0/subjects/23080')) return Response.json({ id: 23080, nsfw: true })
    throw new Error(`unexpected fetch ${text}`)
  }

  try {
    await worker.queue(batch({
      subject_id: 23080,
      title: 'A CN',
      subject_meta: true,
    }) as any, {
      AIRING_CAL_KV: kv,
      AIRING_CAL_R2: r2,
    } as any)

    assert.deepEqual(kv.values.get('subject:meta:23080'), {
      subject_id: 23080,
      exists: true,
      nsfw: true,
      checked_at: (kv.values.get('image:status:23080') as any).subject_checked_at,
      reason: 'subject_detail',
    })
    assert.equal(r2.writes.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker skips a duplicate completed V2 job', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  kv.values.set(subjectRefreshKey(23080), {
    subject_id: 23080,
    job_id: 'instance-1:23080',
    status: 'ok',
    queued_at: 1,
    updated_at: 2,
    completed_at: 2,
    error: null,
  })
  const message = trackedBatch({
    version: 2,
    job_id: 'instance-1:23080',
    subject_id: 23080,
    title: 'A CN',
    components: ['detail', 'meta', 'image_common', 'image_large'],
  })
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    throw new Error('unexpected fetch')
  }) as typeof globalThis.fetch

  try {
    await worker.queue(message.batch as any, { AIRING_CAL_KV: kv, AIRING_CAL_R2: r2 } as any)
    assert.equal(calls, 0)
    assert.equal(message.state.acked, 1)
    assert.deepEqual(message.state.retries, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker handles a fresh V2 candidate without upstream or R2 work', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  const now = Math.floor(Date.now() / 1000)
  kv.values.set(subjectDetailKey(23080), {
    cached_at: now,
    subject: {
      id: 23080,
      nsfw: false,
      images: {
        common: 'https://img.example/common.jpg',
        large: 'https://img.example/large.jpg',
      },
    },
  })
  kv.values.set('image:status:23080', {
    subject_id: 23080,
    common: { status: 'cached', source_url: 'https://img.example/common.jpg' },
    large: { status: 'cached', source_url: 'https://img.example/large.jpg' },
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error('fresh candidate must not call upstream')
  }) as typeof globalThis.fetch

  try {
    const result = await worker.queue(batch({
      version: 2,
      job_id: 'instance-2:23080',
      subject_id: 23080,
      title: 'A CN',
      components: ['detail', 'meta', 'image_common', 'image_large'],
    }) as any, { AIRING_CAL_KV: kv, AIRING_CAL_R2: r2 } as any)

    assert.equal(result, undefined)
    assert.equal(fetchCalls, 0)
    assert.equal(r2.writes.length, 0)
    assert.equal((kv.values.get(subjectRefreshKey(23080)) as any).status, 'ok')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker retries transient V2 failures with bounded delay', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  const message = trackedBatch({
    version: 2,
    job_id: 'instance-1:23080',
    subject_id: 23080,
    title: 'A CN',
    components: ['detail', 'meta'],
  }, 1)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof globalThis.fetch

  try {
    await worker.queue(message.batch as any, { AIRING_CAL_KV: kv, AIRING_CAL_R2: r2 } as any)
    assert.equal(message.state.acked, 0)
    assert.deepEqual(message.state.retries, [{ delaySeconds: 30 }])
    assert.equal((kv.values.get(subjectRefreshKey(23080)) as any).status, 'failed')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('media-worker acks terminal 404 and missing image sources', async () => {
  for (const responseBody of [null, { id: 23080, nsfw: false }]) {
    const kv = new MockKV()
    const r2 = new MockR2()
    const message = trackedBatch({
      version: 2,
      job_id: `instance-${responseBody ? 'missing' : '404'}:23080`,
      subject_id: 23080,
      title: 'A CN',
      components: ['detail', 'meta', 'image_common', 'image_large'],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/v0/subjects/23080')) {
        return responseBody ? Response.json(responseBody) : new Response('Not found', { status: 404 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof globalThis.fetch

    try {
      await worker.queue(message.batch as any, { AIRING_CAL_KV: kv, AIRING_CAL_R2: r2 } as any)
      assert.equal(message.state.acked, 1)
      assert.deepEqual(message.state.retries, [])
      assert.match((kv.values.get(subjectRefreshKey(23080)) as any).status, /partial|failed/)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})
