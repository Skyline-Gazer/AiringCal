import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'

class MockKV {
  values = new Map<string, unknown>()
  listCalls: Array<{ prefix?: string; limit?: number; cursor?: string }> = []

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

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    this.listCalls.push(options ?? {})
    const allKeys = [...this.values.keys()]
      .filter((name) => !options?.prefix || name.startsWith(options.prefix))
      .map((name) => ({ name }))
    const start = Number(options?.cursor ?? 0)
    const limit = options?.limit ?? allKeys.length
    const keys = allKeys.slice(start, start + limit)
    const next = start + keys.length
    return { keys, list_complete: next >= allKeys.length, cursor: next < allKeys.length ? String(next) : undefined }
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

async function setActiveSnapshot(kv: MockKV, instanceId: string, values: Record<string, unknown>, publishedAt = 1783929651) {
  const completeValues = {
    'collections:want': [],
    'collections:watched': [],
    'collections:watching': [],
    'collections:on_hold': [],
    'collections:dropped': [],
    summary: { _total: 0 },
    calendar: [],
    ...values,
  }
  const digests: Record<string, string> = {}
  for (const [suffix, value] of Object.entries(completeValues)) {
    const key = `snapshot:version:${instanceId}:${suffix}`
    kv.values.set(key, value)
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    digests[key] = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  kv.values.set('snapshot:active', {
    instance_id: instanceId,
    generation: 1,
    mode: 'live',
    published_at: publishedAt,
    subject_count: 1,
    required_keys: Object.keys(digests),
    digests,
  })
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

test('read-worker rejects invalid collection type, page, and limit query parameters', async () => {
  for (const query of ['type=unknown', 'page=2junk', 'page=0', 'limit=101']) {
    const response = await worker.fetch(new Request(`https://read.local/collections?${query}`), env() as any)

    assert.equal(response.status, 400, query)
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: 'INVALID_QUERY', message: 'Invalid query parameter' },
    }, query)
  }
})

test('read-worker rejects repeated collection query parameters', async () => {
  for (const query of [
    'type=watching&type=watched',
    'page=1&page=2',
    'limit=24&limit=12',
  ]) {
    const response = await worker.fetch(new Request(`https://read.local/collections?${query}`), env() as any)

    assert.equal(response.status, 400, query)
  }
})

test('read-worker serves the active versioned snapshot after a live Workflow commit', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:collections:watching', [{ subject_id: 515856, collection_type: 3 }])
  await setActiveSnapshot(kv, 'live-status-fix', {
    'collections:watching': [],
    'collections:watched': [{ subject_id: 515856, collection_type: 2 }],
    summary: { watched: 1, watching: 0, _total: 1 },
  })

  const watching = await worker.fetch(new Request('https://read.local/collections?type=watching'), env(kv) as any)
  const watched = await worker.fetch(new Request('https://read.local/collections?type=watched'), env(kv) as any)

  assert.deepEqual((await watching.json() as any).data, [])
  assert.equal((await watched.json() as any).data[0].subject_id, 515856)
})

test('read-worker returns 503 instead of mixing legacy data when active manifest is incomplete', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:collections:watching', [{ subject_id: 999, title: 'legacy' }])
  kv.values.set('snapshot:version:live-incomplete:collections:watching', [{ subject_id: 1, title: 'new' }])
  kv.values.set('snapshot:active', {
    instance_id: 'live-incomplete',
    generation: 2,
    mode: 'live',
    published_at: 1783929651,
    subject_count: 1,
    required_keys: [
      'snapshot:version:live-incomplete:collections:watching',
      'snapshot:version:live-incomplete:calendar',
    ],
    digests: {
      'snapshot:version:live-incomplete:collections:watching': 'ignored-for-missing-key-test',
      'snapshot:version:live-incomplete:calendar': 'missing',
    },
  })

  const response = await worker.fetch(new Request('https://read.local/collections?type=watching'), env(kv) as any)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'SNAPSHOT_INCOMPLETE', message: 'Active snapshot is incomplete' },
  })
})

test('read-worker treats the pre-manifest active pointer as a whole legacy migration snapshot', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:active', { instance_id: 'old-live', mode: 'live', published_at: 1783929651, subject_count: 1 })
  kv.values.set('snapshot:version:old-live:collections:watching', [{ subject_id: 1, title: 'partial version' }])
  kv.values.set('snapshot:collections:watching', [{ subject_id: 2, title: 'legacy set' }])
  kv.values.set('snapshot:summary', { watching: 1, _total: 1 })

  const response = await worker.fetch(new Request('https://read.local/collections?type=watching'), env(kv) as any)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as any).data[0].subject_id, 2)
})

test('read-worker rejects a truncated pre-manifest active pointer', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:active', { instance_id: 'truncated' })
  kv.values.set('snapshot:collections:watching', [{ subject_id: 2, title: 'legacy set' }])

  const response = await worker.fetch(new Request('https://read.local/collections?type=watching'), env(kv) as any)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: 'SNAPSHOT_INCOMPLETE', message: 'Active snapshot is incomplete' },
  })
})

test('read-worker rejects a manifest that omits required collection suffixes', async () => {
  const kv = new MockKV()
  const summary = { _total: 0 }
  const key = 'snapshot:version:live-summary-only:summary'
  kv.values.set(key, summary)
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(summary)))
  kv.values.set('snapshot:active', {
    instance_id: 'live-summary-only', generation: 1, mode: 'live', published_at: 1, subject_count: 0,
    required_keys: [key],
    digests: { [key]: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('') },
  })
  const response = await worker.fetch(new Request('https://read.local/health'), env(kv) as any)
  assert.equal(response.status, 503)
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

  assert.equal(body.page_subjects, 1)
  assert.equal('total_subjects' in body, false)
  assert.equal(body.common.failed, 1)
  assert.equal(body.large.cached, 1)
  assert.equal(JSON.stringify(body).includes('secret-token'), false)
  assert.equal(JSON.stringify(body).includes('source_url'), false)
})

test('read-worker rejects invalid cache limit and cursor query parameters', async () => {
  const queries = [
    'limit=2junk',
    'limit=0',
    'limit=101',
    'cursor=',
    'cursor=%00bad',
    `cursor=${'a'.repeat(1025)}`,
  ]
  for (const query of queries) {
    const response = await worker.fetch(new Request(`https://read.local/cache?${query}`), env() as any)

    assert.equal(response.status, 400, query)
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: 'INVALID_QUERY', message: 'Invalid query parameter' },
    }, query)
  }
})

test('read-worker rejects repeated cache query parameters', async () => {
  for (const query of [
    'limit=24&limit=12',
    'cursor=first&cursor=second',
  ]) {
    const response = await worker.fetch(new Request(`https://read.local/cache?${query}`), env() as any)

    assert.equal(response.status, 400, query)
  }
})

test('read-worker rejects C1 control characters in cache cursors', async () => {
  for (const cursor of ['\u0080', '\u0085', '\u009f']) {
    const response = await worker.fetch(new Request(`https://read.local/cache?cursor=${encodeURIComponent(cursor)}`), env() as any)

    assert.equal(response.status, 400, cursor.charCodeAt(0).toString(16))
  }
})

test('read-worker marks invalid query responses as non-cacheable', async () => {
  for (const path of [
    '/collections?page=0',
    '/cache?limit=0',
  ]) {
    const response = await worker.fetch(new Request(`https://read.local${path}`), env() as any)

    assert.equal(response.status, 400, path)
    assert.equal(response.headers.get('Cache-Control'), 'no-store', path)
  }
})

test('read-worker passes a valid opaque cache cursor through unchanged', async () => {
  const kv = new MockKV()
  const cursor = 'opaque:cursor_1-2.3~value'

  await worker.fetch(new Request(`https://read.local/cache?cursor=${encodeURIComponent(cursor)}`), env(kv) as any)

  assert.equal(kv.listCalls[0]?.cursor, cursor)
})

test('read-worker cache stats use bounded cursor pagination', async () => {
  const kv = new MockKV()
  for (let subjectId = 1; subjectId <= 150; subjectId++) {
    kv.values.set(`image:status:${subjectId}`, {
      subject_id: subjectId,
      common: { status: 'cached' },
      large: { status: 'cached' },
    })
  }

  const first = await worker.fetch(new Request('https://read.local/cache?limit=100'), env(kv) as any)
  const firstBody = await first.json() as any
  const second = await worker.fetch(new Request(`https://read.local/cache?limit=100&cursor=${firstBody.cursor}`), env(kv) as any)
  const secondBody = await second.json() as any

  assert.equal(firstBody.items.length, 100)
  assert.equal(firstBody.cursor, '100')
  assert.equal(secondBody.items.length, 50)
  assert.equal(secondBody.cursor, null)
  assert.deepEqual(kv.listCalls, [
    { prefix: 'image:status:', limit: 100, cursor: undefined },
    { prefix: 'image:status:', limit: 100, cursor: '100' },
  ])
})

test('read-worker bounds cache status hydration concurrency', async () => {
  class ConcurrentKV extends MockKV {
    activeGets = 0
    maxActiveGets = 0

    override async get(key: string, type?: 'json') {
      if (!key.startsWith('image:status:')) return super.get(key, type)
      this.activeGets++
      this.maxActiveGets = Math.max(this.maxActiveGets, this.activeGets)
      await new Promise((resolve) => setTimeout(resolve, 2))
      try {
        return await super.get(key, type)
      } finally {
        this.activeGets--
      }
    }
  }

  const kv = new ConcurrentKV()
  for (let subjectId = 1; subjectId <= 32; subjectId++) {
    kv.values.set(`image:status:${subjectId}`, { subject_id: subjectId })
  }

  await worker.fetch(new Request('https://read.local/cache?limit=32'), env(kv) as any)

  assert.equal(kv.maxActiveGets <= 8, true)
  assert.equal(kv.maxActiveGets > 1, true)
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

test('read-worker health returns complete data when collection count is zero', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:summary', { _total: 0 })

  const response = await worker.fetch(new Request('https://read.local/health'), env(kv) as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.collections.types._total, 0)
  assert.equal(body.data.cache.total_subjects, 0)
  assert.equal(typeof body.data.cron, 'object')
  assert.equal('workflow' in body.data, true)
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

test('read-worker health ignores skipped cron status for footer last status', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:summary', { watching: 20, _total: 42 })
  kv.values.set('sync:meta', {
    synced_at: 1782650300,
    mode: 'merge',
    users: ['alice'],
    cron: {
      last: {
        status: 'skipped',
        source: 'scheduled',
        triggered_at: 1782649200,
      },
    },
  })

  const response = await worker.fetch(new Request('https://read.local/health'), env(kv) as any)
  const body = await response.json() as any

  assert.equal(response.status, 200)
  assert.equal(body.data.cron.last.status, 'synced')
  assert.equal(body.data.cron.last.source, 'snapshot')
  assert.equal(body.data.cron.last.completed_at, 1782650300)
})

test('read-worker health exposes the latest Workflow run and marks stale heartbeat', async () => {
  const kv = new MockKV()
  const heartbeat = Math.floor(Date.now() / 1000) - 21 * 60
  kv.values.set('snapshot:summary', { watched: 1, _total: 1 })
  kv.values.set('sync:meta', {
    synced_at: 1782650300,
    users: ['alice'],
    workflow_instance_id: 'live-stale',
    workflow_stage: 'enqueue',
  })
  kv.values.set('sync:current', { instance_id: 'live-stale', generation: 3, updated_at: heartbeat })
  kv.values.set('sync:run:live-stale', {
    instance_id: 'live-stale',
    mode: 'live',
    source: 'schedule',
    status: 'running',
    stage: 'enqueue',
    started_at: heartbeat - 60,
    heartbeat_at: heartbeat,
    completed_at: null,
    collection_pages: 11,
    subject_count: 549,
    refresh_jobs: 100,
    error: 'Bearer secret-token upstream failed',
  })

  const response = await worker.fetch(new Request('https://read.local/health'), env(kv) as any)
  const health = (await response.json() as any).data
  const workflow = health.workflow

  assert.equal(workflow.instance_id, 'live-stale')
  assert.equal(workflow.stage, 'enqueue')
  assert.equal(workflow.status, 'stale')
  assert.equal(workflow.stale, true)
  assert.equal(health.cron.last.status, 'stale')
  assert.equal(JSON.stringify(workflow).includes('secret-token'), false)
})

test('read-worker health derives snapshot time and last cron from the scheduled Workflow', async () => {
  const kv = new MockKV()
  await setActiveSnapshot(kv, 'scheduled-current', { summary: { watching: 20, _total: 42 } })
  kv.values.set('sync:meta', {
    synced_at: 1782650300,
    users: ['alice'],
    workflow_instance_id: 'scheduled-current',
    cron: {
      last: {
        status: 'running',
        source: 'queue',
        triggered_at: 1783693028,
      },
    },
  })
  kv.values.set('sync:run:scheduled-current', {
    instance_id: 'scheduled-current',
    mode: 'live',
    source: 'schedule',
    status: 'ok',
    stage: 'complete',
    started_at: 1783929651,
    heartbeat_at: 1783929700,
    completed_at: 1783929700,
    collection_pages: 12,
    subject_count: 655,
    refresh_jobs: 655,
    error: null,
  })

  const response = await worker.fetch(new Request('https://read.local/health'), env(kv) as any)
  const health = (await response.json() as any).data

  assert.equal(health.collections.updated_at, '2026-07-13T08:00:51.000Z')
  assert.deepEqual(health.cron.last, {
    status: 'ok',
    source: 'workflow',
    triggered_at: 1783929651,
    completed_at: 1783929700,
  })
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
