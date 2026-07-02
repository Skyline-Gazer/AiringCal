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

test('media-worker downloads common and large images, writes R2 and cache status', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('common.jpg')) return new Response('common-bytes', { headers: { 'content-type': 'image/jpeg' } })
    if (text.includes('large.jpg')) return new Response('large-bytes', { headers: { 'content-type': 'image/png' } })
    if (text.includes('/v0/subjects/23080')) return Response.json({ id: 23080, nsfw: true })
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

test('media-worker treats subject detail 404 as restricted NSFW', async () => {
  const kv = new MockKV()
  const r2 = new MockR2()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('common.jpg')) return new Response('common-bytes', { headers: { 'content-type': 'image/jpeg' } })
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
    if (text.includes('/v0/subjects/23080')) return Response.json({ id: 23080, nsfw: false })
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
    common: { status: 'cached', hash: 'a'.repeat(64), uri: `/image/${'a'.repeat(64)}`, r2_key: `images/${'a'.repeat(64)}/original`, queued_at: 1, cached_at: 1, last_error: null },
    large: { status: 'missing_source', hash: null, uri: null, r2_key: null, queued_at: null, cached_at: null, last_error: null },
    subject_checked_at: 1,
  })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('large.jpg')) return new Response('large-bytes', { headers: { 'content-type': 'image/png' } })
    if (text.includes('/v0/subjects/23080')) return Response.json({ id: 23080, nsfw: false })
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
