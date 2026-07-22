import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSubjectRefreshAt } from '@airing-cal/storage'
import { runSyncWorkflow, type SyncWorkflowEnv, type WorkflowStepLike } from './workflow-core.ts'

class MockKV {
  values = new Map<string, unknown>()
  puts: Array<{ key: string; value: unknown; options?: { expirationTtl?: number } }> = []
  activeStep: string | null = null
  apiCallsByStep = new Map<string, number>()

  private recordCall() {
    if (!this.activeStep) return
    this.apiCallsByStep.set(this.activeStep, (this.apiCallsByStep.get(this.activeStep) ?? 0) + 1)
  }

  async get(key: string, type: 'json') {
    this.recordCall()
    assert.equal(type, 'json')
    return this.values.get(key) ?? null
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.recordCall()
    const parsed = JSON.parse(value)
    this.values.set(key, parsed)
    this.puts.push({ key, value: parsed, options })
  }

  async delete(key: string) {
    this.recordCall()
    this.values.delete(key)
  }

  subjectPuts() {
    return this.puts.filter(({ key }) => key.startsWith('subject:refresh:') || key.startsWith('subject:meta:') || key.startsWith('image:status:'))
  }

  seedCompleteSubject(subjectId: number, cachedAt: number) {
    const common = `https://images.example/${subjectId}/common.jpg`
    const large = `https://images.example/${subjectId}/large.jpg`
    this.values.set(`subject:detail:${subjectId}`, {
      cached_at: cachedAt,
      subject: { id: subjectId, images: { common, large } },
    })
    this.values.set(`subject:meta:${subjectId}`, {
      subject_id: subjectId,
      exists: true,
      nsfw: false,
      checked_at: cachedAt,
      reason: 'subject_detail',
    })
    this.values.set(`image:status:${subjectId}`, {
      subject_id: subjectId,
      common: { status: 'cached', source_url: common },
      large: { status: 'cached', source_url: large },
    })
    this.values.set(`subject:refresh:${subjectId}`, {
      subject_id: subjectId,
      job_id: `previous:${subjectId}`,
      status: 'ok',
      queued_at: cachedAt,
      updated_at: cachedAt,
      completed_at: cachedAt,
      error: null,
    })
  }
}

class TestNonRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonRetryableError'
  }
}

class FakeStep implements WorkflowStepLike {
  names: string[] = []
  attempts = new Map<string, number>()
  outputSizes: number[] = []
  cache = new Map<string, unknown>()

  constructor(private kv?: MockKV) {}

  async do<T>(name: string, config: any, callback: () => Promise<T>): Promise<T> {
    this.names.push(name)
    if (this.cache.has(name)) return this.cache.get(name) as T
    const maxAttempts = (config?.retries?.limit ?? 0) + 1
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.attempts.set(name, attempt)
      try {
        if (this.kv) this.kv.activeStep = name
        const output = await callback()
        this.cache.set(name, output)
        this.outputSizes.push(new TextEncoder().encode(JSON.stringify(output)).byteLength)
        return output
      } catch (error) {
        if (error instanceof TestNonRetryableError || attempt === maxAttempts) throw error
      } finally {
        if (this.kv) this.kv.activeStep = null
      }
    }
    throw new Error('unreachable')
  }
}

class MockSnapshotCoordinator {
  commits: any[] = []
  constructor(private kv: MockKV, readonly generation = 7) {}

  binding() {
    return {
      getByName: (name: string) => {
        assert.equal(name, 'snapshot-global')
        return {
          fetch: async (request: Request) => {
            const body = await request.json() as any
            if (new URL(request.url).pathname === '/allocate') return Response.json({ generation: this.generation })
            this.commits.push(body.manifest)
            this.kv.values.set('snapshot:active', body.manifest)
            return Response.json({ status: 'committed', generation: body.generation })
          },
        }
      },
    }
  }
}

function workflowEnv(kv: MockKV, queueMessages: unknown[], coordinator = new MockSnapshotCoordinator(kv)): SyncWorkflowEnv {
  return {
    AIRING_CAL_KV: kv,
    SNAPSHOT_COORDINATOR: coordinator.binding(),
    MEDIA_QUEUE: {
      sendBatch: async (messages) => { queueMessages.push(...messages.map((message) => message.body)) },
    },
    BANGUMI_TOKEN: 'server-token',
    BANGUMI_USERS: 'alice',
  }
}

function collection(subjectId: number) {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 7,
    type: 3,
    comment: '',
    tags: [],
    ep_status: 1,
    vol_status: 0,
    updated_at: '2026-07-10T00:00:00.000Z',
    private: false,
    subject: {
      id: subjectId,
      type: 2,
      name: `Anime ${subjectId}`,
      name_cn: '',
      summary: '',
      nsfw: false,
      date: '2026-07-01',
      eps: 12,
      total_episodes: 12,
      images: {
        common: `https://images.example/${subjectId}/common.jpg`,
        large: `https://images.example/${subjectId}/large.jpg`,
      },
      rating: { score: 0, rank: 0, total: 0 },
    },
  }
}

test('shadow workflow fetches 549 collections in 11 deterministic page steps without subject API calls', async () => {
  const kv = new MockKV()
  kv.values.set('snapshot:collections:watching', [{ subject_id: 999, title: 'live' }])
  const queueMessages: unknown[] = []
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('/collections?')) {
      const offset = Number(new URL(text).searchParams.get('offset'))
      const count = Math.min(50, 549 - offset)
      return Response.json({ total: 549, data: Array.from({ length: count }, (_, index) => collection(offset + index + 1)) })
    }
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await runSyncWorkflow(workflowEnv(kv, queueMessages), {
      instanceId: 'shadow-commit',
      payload: { mode: 'shadow', source: 'manual' },
      schedule: undefined,
    }, step, (message) => new TestNonRetryableError(message))

    assert.deepEqual(step.names.filter((name) => name.startsWith('fetch-collections-page-')), Array.from({ length: 11 }, (_, index) => `fetch-collections-page-${index}`))
    assert.equal(calls.filter((url) => url.includes('/collections?')).length, 11)
    assert.equal(calls.some((url) => url.includes('/v0/subjects/')), false)
    assert.equal(step.outputSizes.every((size) => size < 1024 * 1024), true)
    assert.equal(kv.values.has('snapshot:shadow:shadow-commit:collections:watching'), true)
    assert.deepEqual(kv.values.get('snapshot:collections:watching'), [{ subject_id: 999, title: 'live' }])
    assert.equal(queueMessages.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('workflow classifies authentication as non-retryable and retries transient HTTP failures', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const kv = new MockKV()
    const step = new FakeStep(kv)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('upstream', { status, headers: status === 429 ? { 'Retry-After': '0' } : undefined })) as typeof globalThis.fetch
    try {
      await assert.rejects(() => runSyncWorkflow(workflowEnv(kv, []), {
        instanceId: `failure-${status}`,
        payload: { mode: 'shadow', source: 'manual' },
        schedule: undefined,
      }, step, (message) => new TestNonRetryableError(message)))
      assert.equal(step.attempts.get('fetch-collections-page-0'), status === 401 || status === 403 ? 1 : 4)
      assert.deepEqual(kv.values.get('snapshot:collections:watching'), undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('workflow retries timeout and network failures at the step boundary', async () => {
  for (const upstreamError of [
    new DOMException('timed out', 'TimeoutError'),
    new TypeError('network unavailable'),
  ]) {
    const kv = new MockKV()
    const step = new FakeStep(kv)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw upstreamError }) as typeof globalThis.fetch
    try {
      await assert.rejects(() => runSyncWorkflow(workflowEnv(kv, []), {
        instanceId: `failure-${upstreamError.name}`,
        payload: { mode: 'shadow', source: 'manual' },
        schedule: undefined,
      }, step, (message) => new TestNonRetryableError(message)))
      assert.equal(step.attempts.get('fetch-collections-page-0'), 4)
      assert.deepEqual(kv.values.get('snapshot:collections:watching'), undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('live workflow keeps refresh planning and enqueue below the 50-call Free Plan budget', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 100, data: Array.from({ length: 50 }, (_, index) => collection(Number(new URL(text).searchParams.get('offset')) + index + 1)) })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await runSyncWorkflow(workflowEnv(kv, queueMessages), {
      instanceId: 'live-1',
      payload: { mode: 'live', source: 'manual' },
      schedule: undefined,
    }, step, (message) => new TestNonRetryableError(message))

    assert.deepEqual(step.names.filter((name) => name.startsWith('plan-refresh-')), Array.from({ length: 10 }, (_, index) => `plan-refresh-${index}`))
    assert.deepEqual(step.names.filter((name) => name.startsWith('enqueue-refresh-')), Array.from({ length: 4 }, (_, index) => `enqueue-refresh-${index}`))
    const refreshInputs = [...kv.values.entries()]
      .filter(([key]) => key.includes(':refresh-inputs'))
      .flatMap(([, value]) => value as unknown[])
    assert.equal(refreshInputs.length, 100)
    const queuedBatches = step.names.filter((name) => name.startsWith('enqueue-refresh-')).length
    assert.equal(queuedBatches, 4)
    assert.equal([...kv.values.keys()].some((key) => key.startsWith('subject:refresh:')), false)
    assert.equal([...kv.apiCallsByStep.values()].every((calls) => calls <= 50), true)
    assert.equal([...kv.apiCallsByStep.entries()].filter(([name]) => name.startsWith('plan-refresh-')).every(([, calls]) => calls <= 50), true)
    assert.equal([...kv.apiCallsByStep.entries()].filter(([name]) => name.startsWith('enqueue-refresh-')).every(([, calls]) => calls <= 4), true)
    assert.equal([...kv.apiCallsByStep.values()].reduce((total, calls) => total + calls, 0) < 500, true)
    assert.equal((kv.values.get('snapshot:active') as any).instance_id, 'live-1')
    assert.equal((kv.values.get('snapshot:active') as any).generation, 7)
    assert.equal(queueMessages.length, 100)
    assert.equal(new Set((queueMessages as any[]).map((job) => job.job_id)).size, 100)
    assert.equal((queueMessages as any[]).every((job) => job.version === 3 && job.generation === 7), true)
    assert.equal(step.names.indexOf('commit-live-snapshot') > step.names.indexOf('enqueue-refresh-3'), true)
    assert.equal((kv.values.get('sync:current') as any).instance_id, 'live-1')

    const putCount = kv.puts.length
    await runSyncWorkflow(workflowEnv(kv, queueMessages), {
      instanceId: 'live-1',
      payload: { mode: 'live', source: 'manual' },
      schedule: undefined,
    }, step, (message) => new TestNonRetryableError(message))
    assert.equal(kv.puts.length, putCount)
    assert.equal(queueMessages.length, 100)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('unchanged 659-subject workflow enqueues no media and performs no subject KV PUTs', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const step = new FakeStep(kv)
  const cachedAt = Math.floor(Date.now() / 1000) - 1
  for (let subjectId = 1; subjectId <= 659; subjectId++) {
    assert.ok(nextSubjectRefreshAt(subjectId, cachedAt) > Math.floor(Date.now() / 1000))
    kv.seedCompleteSubject(subjectId, cachedAt)
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) {
      const offset = Number(new URL(text).searchParams.get('offset'))
      const count = Math.min(50, 659 - offset)
      return Response.json({ total: 659, data: Array.from({ length: count }, (_, index) => collection(offset + index + 1)) })
    }
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await runSyncWorkflow(workflowEnv(kv, queueMessages), {
      instanceId: 'unchanged-659',
      payload: { mode: 'live', source: 'manual' },
      schedule: undefined,
    }, step, (message) => new TestNonRetryableError(message))

    assert.equal(queueMessages.length, 0)
    assert.deepEqual(kv.subjectPuts(), [])
    assert.equal((kv.values.get('snapshot:active') as any).instance_id, 'unchanged-659')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('live workflow does not commit active snapshot when enqueue fails', async () => {
  const kv = new MockKV()
  const coordinator = new MockSnapshotCoordinator(kv, 8)
  const env = workflowEnv(kv, [], coordinator)
  env.MEDIA_QUEUE.sendBatch = async () => { throw new Error('queue unavailable') }
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 1, data: [collection(1)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await assert.rejects(() => runSyncWorkflow(env, {
      instanceId: 'live-enqueue-failure',
      payload: { mode: 'live', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message)), /queue unavailable/)
    assert.equal(coordinator.commits.length, 0)
    assert.equal(kv.values.has('snapshot:active'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
