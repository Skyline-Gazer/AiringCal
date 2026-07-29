import assert from 'node:assert/strict'
import test from 'node:test'
import { SubjectRefreshCoordinator, SubjectRefreshCoordinatorCore } from './subject-refresh-coordinator.ts'

class MemoryState {
  values = new Map<string, unknown>()
  async get<T>(key: string) { return this.values.get(key) as T | undefined }
  async put<T>(key: string, value: T) { this.values.set(key, value) }
}

test('older subject generations become obsolete after a newer generation completes', async () => {
  const coordinator = new SubjectRefreshCoordinatorCore(new MemoryState())
  assert.deepEqual(await coordinator.begin(2, 'job-new'), { status: 'process', generation: 2 })
  await coordinator.complete(2, 'job-new')
  assert.deepEqual(await coordinator.begin(1, 'job-old'), { status: 'obsolete', generation: 1 })
})

test('legacy generation zero only runs before a V3 generation is processed', async () => {
  const coordinator = new SubjectRefreshCoordinatorCore(new MemoryState())
  assert.equal((await coordinator.begin(0, 'legacy-first')).status, 'process')
  await coordinator.complete(0, 'legacy-first')
  assert.equal((await coordinator.begin(3, 'job-v3')).status, 'process')
  await coordinator.complete(3, 'job-v3')
  assert.equal((await coordinator.begin(0, 'legacy-late')).status, 'obsolete')
})

test('the same completed job is a duplicate instead of being processed twice', async () => {
  const coordinator = new SubjectRefreshCoordinatorCore(new MemoryState())
  assert.equal((await coordinator.begin(4, 'job-4')).status, 'process')
  await coordinator.complete(4, 'job-4')
  assert.equal((await coordinator.begin(4, 'job-4')).status, 'duplicate')
})

test('production Durable Object fences V3 and replay-stable V4 generations independently', async () => {
  const state = new MemoryState()
  const kv = {
    values: new Map<string, unknown>(),
    async get(key: string) { return this.values.get(key) ?? null },
    async put(key: string, value: string) { this.values.set(key, JSON.parse(value)) },
    async delete(key: string) { this.values.delete(key) },
  }
  const d1Calls = { reads: 0, writes: 0 }
  const d1 = {
    prepare() {
      return {
        bind() { return this },
        async first() { d1Calls.reads++; return null },
        async all() { throw new Error('unexpected D1 all') },
        async run() { throw new Error('unexpected D1 run') },
        async raw() { throw new Error('unexpected D1 raw') },
      }
    },
    async batch() {
      d1Calls.writes++
      return [{
        results: [],
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: 0,
          rows_written: 1,
          last_row_id: 23080,
          changed_db: true,
          changes: 1,
        },
      }]
    },
    async exec() { return { count: 0, duration: 0 } },
  }
  const coordinator = new SubjectRefreshCoordinator({ storage: state } as any, {
    AIRING_CAL_D1: d1,
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { async get() { return null }, async put() { return {} } },
  } as any)
  const upstream = { calls: 0 }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    upstream.calls++
    return Response.json({
      id: 23080,
      type: 2,
      name: 'A',
      name_cn: 'A CN',
      summary: '',
      date: '2026-01-01',
      eps: 12,
      total_episodes: 12,
      nsfw: false,
      images: {},
    })
  }
  const v3 = (generation: number) => ({
    version: 3,
    generation,
    job_id: `live-${generation}:23080`,
    subject_id: 23080,
    title: `Live ${generation}`,
    components: [],
  })
  const v4 = (observedAt: number, runId: string) => ({
    version: 4,
    generation: { observed_at: observedAt, run_id: runId },
    job_id: `${runId}:23080`,
    subject_id: 23080,
    title: runId,
    components: [],
  })
  const process = async (body: unknown) => {
    const response = await coordinator.fetch(new Request('https://subject-refresh-coordinator/process', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() as any }
  }

  try {
    assert.deepEqual(await process(v3(10)), {
      status: 200,
      body: { status: 'processed', generation: 10 },
    })
    assert.deepEqual(await process(v4(100, 'shadow-a')), {
      status: 200,
      body: { status: 'processed', generation: { observed_at: 100, run_id: 'shadow-a' } },
    })
    assert.deepEqual(await process(v4(100, 'shadow-a')), {
      status: 200,
      body: { status: 'duplicate', generation: { observed_at: 100, run_id: 'shadow-a' } },
    })
    assert.deepEqual(await process(v4(101, 'shadow-b')), {
      status: 200,
      body: { status: 'processed', generation: { observed_at: 101, run_id: 'shadow-b' } },
    })
    assert.deepEqual(await process(v4(100, 'shadow-a')), {
      status: 200,
      body: { status: 'obsolete', generation: { observed_at: 100, run_id: 'shadow-a' } },
    })
    assert.deepEqual(await process(v3(11)), {
      status: 200,
      body: { status: 'processed', generation: 11 },
    })
    assert.equal(upstream.calls, 2)
    assert.deepEqual(d1Calls, { reads: 2, writes: 2 })
    assert.equal(state.values.get('lastCompletedGeneration'), 11)
    assert.deepEqual(state.values.get('v4:lastCompletedGeneration'), {
      observed_at: 101,
      run_id: 'shadow-b',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the Durable Object rejects an unknown present version before fence or external side effects', async () => {
  const state = new MemoryState()
  const calls = { kv: 0, r2: 0, d1: 0, upstream: 0 }
  const coordinator = new SubjectRefreshCoordinator({ storage: state } as any, {
    AIRING_CAL_D1: {
      prepare() { calls.d1++; throw new Error('unexpected D1 access') },
    },
    AIRING_CAL_KV: {
      async get() { calls.kv++; return null },
      async put() { calls.kv++ },
      async delete() { calls.kv++ },
    },
    AIRING_CAL_R2: {
      async get() { calls.r2++; return null },
      async put() { calls.r2++; return {} },
    },
  } as any)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls.upstream++
    throw new Error('unexpected upstream access')
  }

  try {
    const response = await coordinator.fetch(new Request('https://subject-refresh-coordinator/process', {
      method: 'POST',
      body: JSON.stringify({
        version: 5,
        generation: 1,
        job_id: 'unknown-do:23080',
        subject_id: 23080,
        title: 'Unknown',
        components: [],
      }),
    }))
    assert.equal(response.status, 400)
    assert.equal(state.values.size, 0)
    assert.deepEqual(calls, { kv: 0, r2: 0, d1: 0, upstream: 0 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a D1-only V4 job without D1 fails without legacy KV writes and still makes an older retry obsolete', async () => {
  const state = new MemoryState()
  const kv = {
    values: new Map<string, unknown>(),
    puts: 0,
    async get(key: string) { return this.values.get(key) ?? null },
    async put(key: string, value: string) { this.puts++; this.values.set(key, JSON.parse(value)) },
    async delete(key: string) { this.values.delete(key) },
  }
  const coordinator = new SubjectRefreshCoordinator({ storage: state } as any, {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { async get() { return null }, async put() { return {} } },
  } as any)
  const request = (generation: number, components: string[]) => new Request('https://subject-refresh-coordinator/process', {
    method: 'POST',
    body: JSON.stringify({
      version: 4,
      generation: { observed_at: generation, run_id: `job-${generation}` },
      job_id: `job-${generation}`,
      subject_id: 23080,
      title: `Job ${generation}`,
      components, images: { common: 'https://img.example/fail.jpg' },
    }),
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('new generation failed') }
  try {
    assert.equal((await coordinator.fetch(request(2, ['image_common']))).status, 503)
    const obsolete = await coordinator.fetch(request(1, []))
    assert.deepEqual(await obsolete.json(), {
      status: 'obsolete',
      generation: { observed_at: 1, run_id: 'job-1' },
    })
    assert.equal(kv.puts, 0)
    assert.equal(kv.values.has('subject:refresh:23080'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the Durable Object leaves business KV unchanged for duplicate and obsolete jobs', async () => {
  const state = new MemoryState()
  state.values.set('lastCompletedGeneration', 3)
  state.values.set('lastCompletedJob', 'job-3')
  state.values.set('highestAcceptedGeneration', 3)
  const kv = {
    values: new Map<string, unknown>(),
    puts: 0,
    async get(key: string) { return this.values.get(key) ?? null },
    async put(key: string, value: string) { this.puts++; this.values.set(key, JSON.parse(value)) },
    async delete(key: string) { this.values.delete(key) },
  }
  const coordinator = new SubjectRefreshCoordinator({ storage: state } as any, {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { async get() { return null }, async put() { return {} } },
  } as any)
  const request = (generation: number) => new Request('https://subject-refresh-coordinator/process', {
    method: 'POST',
    body: JSON.stringify({
      version: 3,
      generation,
      job_id: `job-${generation}`,
      subject_id: 23080,
      title: 'A CN',
      components: [],
    }),
  })

  const putsAfterNewJob = kv.puts
  const duplicate = await coordinator.fetch(request(3))
  assert.deepEqual(await duplicate.json(), { status: 'duplicate', generation: 3 })
  assert.equal(kv.puts, putsAfterNewJob)
  const obsolete = await coordinator.fetch(request(2))
  assert.deepEqual(await obsolete.json(), { status: 'obsolete', generation: 2 })
  assert.equal(kv.puts, putsAfterNewJob)
})

test('concurrent process requests stay serialized across image download awaits', async () => {
  const state = new MemoryState()
  const kv = {
    values: new Map<string, unknown>(),
    async get(key: string) { return this.values.get(key) ?? null },
    async put(key: string, value: string) { this.values.set(key, JSON.parse(value)) },
    async delete(key: string) { this.values.delete(key) },
  }
  const coordinator = new SubjectRefreshCoordinator({ storage: state } as any, {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { async get() { return null }, async put() { return {} } },
  } as any)
  let releaseOld!: () => void
  let oldStarted!: () => void
  const oldDownload = new Promise<void>((resolve) => { releaseOld = resolve })
  const started = new Promise<void>((resolve) => { oldStarted = resolve })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('old.jpg')) {
      oldStarted()
      await oldDownload
      return new Response('old')
    }
    if (String(url).includes('new.jpg')) return new Response('new')
    throw new Error(`unexpected fetch ${url}`)
  }
  const request = (generation: number, image: string) => new Request('https://subject-refresh-coordinator/process', {
    method: 'POST',
    body: JSON.stringify({
      version: 2, job_id: `job-${generation}`, subject_id: 23080, title: `Job ${generation}`,
      components: ['image_common'], images: { common: `https://img.example/${image}` },
    }),
  })

  try {
    const older = coordinator.fetch(request(1, 'old.jpg'))
    await started
    const newer = coordinator.fetch(request(2, 'new.jpg'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseOld()
    await Promise.all([older, newer])
    assert.equal((kv.values.get('image:status:23080') as any).title, 'Job 2')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a D1 binding does not suppress legacy V2 failure persistence', async () => {
  const state = new MemoryState()
  const kv = {
    values: new Map<string, unknown>(),
    async get(key: string) { return this.values.get(key) ?? null },
    async put(key: string, value: string) { this.values.set(key, JSON.parse(value)) },
    async delete(key: string) { this.values.delete(key) },
  }
  const coordinator = new SubjectRefreshCoordinator({ storage: state } as any, {
    AIRING_CAL_D1: {},
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { async get() { return null }, async put() { return {} } },
  } as any)
  const request = new Request('https://subject-refresh-coordinator/process', {
    method: 'POST',
    body: JSON.stringify({
      version: 2,
      job_id: 'legacy-v2:23080',
      subject_id: 23080,
      title: 'Legacy V2',
      components: ['image_common'],
      images: { common: 'https://img.example/fail.jpg' },
    }),
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network down') }

  try {
    assert.equal((await coordinator.fetch(request)).status, 503)
    assert.equal((kv.values.get('subject:refresh:23080') as any)?.status, 'failed')
  } finally {
    globalThis.fetch = originalFetch
  }
})
