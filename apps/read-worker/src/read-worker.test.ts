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

  async list(options?: { prefix?: string }) {
    const keys = [...this.values.keys()]
      .filter((name) => !options?.prefix || name.startsWith(options.prefix))
      .map((name) => ({ name }))
    return { keys, list_complete: true, cursor: undefined }
  }
}

class MockR2 {
  async get(hash: string) {
    if (hash !== `images/${'a'.repeat(64)}/original`) return null
    return {
      arrayBuffer: async () => new TextEncoder().encode('image').buffer,
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { bytes: '5', source_size: 'common' },
    }
  }
}

function env(kv = new MockKV()) {
  return {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: new MockR2(),
    NSFW_SHOW: 'true',
  }
}

test('read-worker returns collection snapshot by type from KV', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:collections:watching', [{ subject_id: 1, title: 'A' }])
  kv.values.set('snapshot:summary', { watching: 1, _total: 1 })

  const response = await worker.fetch(new Request('https://read.local/collections?type=watching'), env(kv) as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.deepEqual(body.data, [{ subject_id: 1, title: 'A' }])
  assert.deepEqual(body.types, { watching: 1, _total: 1 })
})

test('read-worker paginates collection snapshots by page and limit', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:collections:watching', Array.from({ length: 5 }, (_, index) => ({
    subject_id: index + 1,
    title: `Subject ${index + 1}`,
  })))
  kv.values.set('snapshot:summary', { watching: 5, _total: 5 })

  const response = await worker.fetch(new Request('https://read.local/collections?type=watching&page=2&limit=2'), env(kv) as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.total, 5)
  assert.equal(body.page, 2)
  assert.equal(body.limit, 2)
  assert.deepEqual(body.data.map((entry: any) => entry.subject_id), [3, 4])
})

test('read-worker cache stats expose sanitized image cache data only', async () => {
  const kv = new MockKV()
  kv.values.set('image:status:23080', {
    subject_id: 23080,
    title: 'Sensitive',
    common: { status: 'failed', hash: null, uri: null, r2_key: null, last_error: 'Bearer secret-token upstream failed' },
    large: { status: 'cached', hash: 'b'.repeat(64), uri: `/image/${'b'.repeat(64)}`, r2_key: `images/${'b'.repeat(64)}/original`, last_error: null, source_url: 'https://img.example/large.jpg' },
  })

  const response = await worker.fetch(new Request('https://read.local/cache'), env(kv) as any)
  const body = await response.json() as any

  assert.equal(body.total_subjects, 1)
  assert.equal(body.common.failed, 1)
  assert.equal(body.large.cached, 1)
  assert.equal(JSON.stringify(body).includes('secret-token'), false)
  assert.equal(JSON.stringify(body).includes('source_url'), false)
})

test('read-worker serves images from R2 by hash', async () => {
  const response = await worker.fetch(new Request(`https://read.local/image/${'a'.repeat(64)}`), env() as any)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/png')
  assert.equal(await response.text(), 'image')
})

test('read-worker health reports collection snapshot status when KV has data', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:summary', { watching: 20, _total: 42 })
  kv.values.set('sync:meta', {
    synced_at: 1782650300,
    mode: 'merge',
    users: ['alice'],
    cron: {
      last: {
        status: 'ok',
        source: 'scheduled',
        triggered_at: 1782650000,
        completed_at: 1782650300,
      },
    },
  })

  const response = await worker.fetch(new Request('https://read.local/health'), env(kv) as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.data.collections.types._total, 42)
  assert.equal(body.data.collections.updated_at, '2026-06-28T12:38:20.000Z')
  assert.equal(body.data.cache.total_subjects, 42)
  assert.match(body.data.cron.next_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(body.data.cron.last.status, 'ok')
})

test('read-worker health falls back to snapshot sync time when cron status is missing', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:summary', { watching: 20, _total: 42 })
  kv.values.set('sync:meta', {
    synced_at: 1782650300,
    mode: 'merge',
    users: ['alice'],
  })

  const response = await worker.fetch(new Request('https://read.local/health'), env(kv) as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.cron.last.status, 'synced')
  assert.equal(body.data.cron.last.source, 'snapshot')
  assert.equal(body.data.cron.last.completed_at, 1782650300)
})

test('read-worker does not call upstream fetch for read requests', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('upstream fetch should not be called')
  }
  try {
    const response = await worker.fetch(new Request('https://read.local/health'), env() as any)
    assert.equal(response.status, 200)
  } finally {
    globalThis.fetch = originalFetch
  }
})
