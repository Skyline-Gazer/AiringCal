import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSubjectRefreshAt, syncStagingKey } from '@airing-cal/storage'
import { SnapshotCoordinator } from './snapshot-coordinator.ts'
import { runSyncWorkflow, type SyncWorkflowEnv, type WorkflowStepLike } from './workflow-core.ts'

class MockKV {
  values = new Map<string, unknown>()
  puts: Array<{ key: string; value: unknown; options?: { expirationTtl?: number } }> = []
  activeStep: string | null = null
  apiCallsByStep = new Map<string, number>()
  externalCallsByStep = new Map<string, number>()
  failingGets = new Set<string>()
  nullGets = new Set<string>()
  nullOnceGets = new Set<string>()
  replacementGets = new Map<string, unknown>()

  private recordCall() {
    if (!this.activeStep) return
    this.apiCallsByStep.set(this.activeStep, (this.apiCallsByStep.get(this.activeStep) ?? 0) + 1)
  }

  async get(key: string, type: 'json') {
    this.recordCall()
    assert.equal(type, 'json')
    if (this.failingGets.has(key)) throw new Error(`KV read failed for ${key}`)
    if (this.nullGets.has(key)) return null
    if (this.nullOnceGets.delete(key)) return null
    if (this.replacementGets.has(key)) return this.replacementGets.get(key)
    return this.values.get(key) ?? null
  }

  recordExternalCall() {
    if (!this.activeStep) return
    this.externalCallsByStep.set(this.activeStep, (this.externalCallsByStep.get(this.activeStep) ?? 0) + 1)
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
  reservations: any[] = []
  requests: string[] = []
  private budget: { date: string; consumed: number } | null = null
  private reservationResults = new Map<string, { granted: number; consumed: number; soft_limit: number; hard_limit: number; submission: 'confirmed' | 'not_needed' }>()
  private queueMessages: unknown[] = []
  loseNextReservationResponse = false
  failCommit = false

  constructor(private kv: MockKV, readonly generation = 7, private maxGrant = Number.POSITIVE_INFINITY) {}

  attachQueue(queueMessages: unknown[]) {
    this.queueMessages = queueMessages
  }

  seedBudget(date: string, consumed: number) {
    this.budget = { date, consumed }
  }

  get consumed() {
    return this.budget?.consumed ?? 0
  }

  binding() {
    return {
      getByName: (name: string) => {
        assert.equal(name, 'snapshot-global')
        return {
          fetch: async (request: Request) => {
            const body = await request.json() as any
            const path = new URL(request.url).pathname
            this.requests.push(path)
            this.kv.recordExternalCall()
            if (path === '/allocate') return Response.json({ generation: this.generation })
            if (path === '/reserve-media') {
              this.reservations.push(body)
              const existing = this.reservationResults.get(body.reservation_id)
              if (existing) return Response.json(existing)
              const previousBudget = this.budget
              if (previousBudget && body.date < previousBudget.date) {
                return Response.json({ granted: 0, consumed: previousBudget.consumed, soft_limit: 50, hard_limit: 100, submission: 'not_needed' })
              }
              const consumed = previousBudget && previousBudget.date === body.date ? previousBudget.consumed : 0
              const privileged = Math.min(body.requested, body.privileged_requested)
              const privilegedGranted = Math.min(privileged, Math.max(0, 100 - consumed))
              const ordinaryGranted = Math.min(body.requested - privileged, Math.max(0, 50 - consumed - privilegedGranted))
              const granted = Math.min(privilegedGranted + ordinaryGranted, this.maxGrant)
              const result = {
                granted,
                consumed: consumed + granted,
                soft_limit: 50,
                hard_limit: 100,
                submission: granted > 0 ? 'confirmed' as const : 'not_needed' as const,
              }
              this.budget = { date: body.date, consumed: result.consumed }
              this.reservationResults.set(body.reservation_id, result)
              this.queueMessages.push(...body.jobs.slice(0, granted))
              if (this.loseNextReservationResponse) {
                this.loseNextReservationResponse = false
                throw new Error('coordinator response lost')
              }
              return Response.json(result)
            }
            if (this.failCommit) return Response.json({ error: 'commit failed' }, { status: 503 })
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
  coordinator.attachQueue(queueMessages)
  return {
    AIRING_CAL_KV: kv,
    SNAPSHOT_COORDINATOR: coordinator.binding(),
    MEDIA_QUEUE: {
      sendBatch: async (messages) => {
        kv.recordExternalCall()
        queueMessages.push(...messages.map((message) => message.body))
      },
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
  const coordinator = new MockSnapshotCoordinator(kv)
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const openApiCalendar = [{
    weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
    items: [{
      id: 12,
      url: 'https://bgm.tv/subject/12',
      type: 2,
      name: 'A',
      name_cn: 'A CN',
      summary: 'summary',
      air_date: '2026-01-01',
      air_weekday: 1,
      eps: 12,
      eps_count: 13,
      images: { common: 'common' },
      rating: { total: 2289, score: 7.6, count: { 10: 130 } },
      rank: 573,
      collection: { wish: 1 },
    }],
  }]
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    calls.push(text)
    if (text.includes('/collections?')) {
      const offset = Number(new URL(text).searchParams.get('offset'))
      const count = Math.min(50, 549 - offset)
      return Response.json({ total: 549, data: Array.from({ length: count }, (_, index) => collection(offset + index + 1)) })
    }
    if (text.endsWith('/calendar')) return Response.json(openApiCalendar)
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await runSyncWorkflow(workflowEnv(kv, queueMessages, coordinator), {
      instanceId: 'shadow-commit',
      payload: { mode: 'shadow', source: 'manual' },
      schedule: undefined,
    }, step, (message) => new TestNonRetryableError(message))

    assert.deepEqual(step.names.filter((name) => name.startsWith('fetch-collections-page-')), Array.from({ length: 11 }, (_, index) => `fetch-collections-page-${index}`))
    assert.equal(calls.filter((url) => url.includes('/collections?')).length, 11)
    assert.equal(calls.some((url) => url.includes('/v0/subjects/')), false)
    assert.equal(step.outputSizes.every((size) => size < 1024 * 1024), true)
    assert.equal(kv.values.has('snapshot:shadow:shadow-commit:collections:watching'), true)
    assert.deepEqual(kv.values.get('snapshot:shadow:shadow-commit:calendar'), [{
      weekday: openApiCalendar[0]!.weekday,
      items: [{
        subject_id: 12,
        id: 12,
        type: 2,
        name: 'A',
        name_cn: 'A CN',
        summary: 'summary',
        images: { common: null, large: null },
        nsfw: false,
        date: '2026-01-01',
        eps: 12,
        total_episodes: 12,
        rating: { score: 7.6, rank: 573, total: 2289 },
      }],
    }])
    assert.deepEqual(kv.values.get('snapshot:collections:watching'), [{ subject_id: 999, title: 'live' }])
    assert.equal(queueMessages.length, 0)
    assert.deepEqual(coordinator.requests, [])
    assert.equal(step.names.some((name) => name.startsWith('plan-refresh-')), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('workflow never prepares or commits deletion-capable input when a staged collection page disappears', async () => {
  const kv = new MockKV()
  kv.nullGets.add(syncStagingKey('partial-staging', 'collections:0:1'))
  const coordinator = new MockSnapshotCoordinator(kv)
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) {
      const offset = Number(new URL(text).searchParams.get('offset'))
      return Response.json({
        total: 51,
        data: offset === 0
          ? Array.from({ length: 50 }, (_, index) => collection(index + 1))
          : [collection(51)],
      })
    }
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await assert.rejects(
      runSyncWorkflow(workflowEnv(kv, [], coordinator), {
        instanceId: 'partial-staging',
        payload: { mode: 'shadow', source: 'manual' },
      }, step, (message) => new TestNonRetryableError(message)),
      /Incomplete collection fetch/,
    )
    assert.equal(coordinator.commits.length, 0)
    assert.equal(step.names.includes('publish-calendar'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('workflow rejects staged collection content whose digest differs from the fetched page', async () => {
  const kv = new MockKV()
  kv.replacementGets.set(syncStagingKey('tampered-staging', 'collections:0:0'), [collection(999)])
  const coordinator = new MockSnapshotCoordinator(kv)
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 1, data: [collection(1)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await assert.rejects(
      runSyncWorkflow(workflowEnv(kv, [], coordinator), {
        instanceId: 'tampered-staging',
        payload: { mode: 'shadow', source: 'manual' },
      }, step, (message) => new TestNonRetryableError(message)),
      /digest/i,
    )
    assert.equal(coordinator.commits.length, 0)
    assert.equal(step.names.includes('publish-calendar'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('workflow rejects a structurally valid staged calendar whose digest differs from the fetched payload', async () => {
  const kv = new MockKV()
  const fetchedCalendar = [{
    weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
    items: [{
      id: 1, type: 2, name: 'A', name_cn: '', summary: '', date: '', eps: 1,
      images: { large: '', common: '', medium: '', small: '', grid: '' },
      rating: { score: 0, rank: 0, total: 0 },
    }],
  }]
  kv.replacementGets.set(syncStagingKey('tampered-calendar', 'calendar'), [{
    ...fetchedCalendar[0],
    weekday: { ...fetchedCalendar[0]!.weekday, cn: '被篡改' },
  }])
  const coordinator = new MockSnapshotCoordinator(kv)
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 0, data: [] })
    if (text.endsWith('/calendar')) return Response.json(fetchedCalendar)
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await assert.rejects(
      runSyncWorkflow(workflowEnv(kv, [], coordinator), {
        instanceId: 'tampered-calendar',
        payload: { mode: 'shadow', source: 'manual' },
      }, step, (message) => new TestNonRetryableError(message)),
      /calendar digest/i,
    )
    assert.equal(coordinator.commits.length, 0)
    assert.equal(step.names.includes('publish-calendar'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('workflow accepts the same subject for two users while retaining a stable observation across step retry', async () => {
  const kv = new MockKV()
  kv.nullOnceGets.add(syncStagingKey('multi-user-retry', 'collections:1:0'))
  const coordinator = new MockSnapshotCoordinator(kv)
  const step = new FakeStep(kv)
  const env = workflowEnv(kv, [], coordinator)
  env.BANGUMI_USERS = 'alice,bob'
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 1, data: [collection(1)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await runSyncWorkflow(env, {
      instanceId: 'multi-user-retry',
      payload: { mode: 'shadow', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message))

    assert.equal(step.attempts.get('prepare-snapshot-inputs'), 2)
    const run = kv.values.get('sync:run:multi-user-retry') as { started_at: number }
    const prepared = kv.values.get(syncStagingKey('multi-user-retry', 'prepared')) as { observedAt: number }
    assert.equal(prepared.observedAt, run.started_at)
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

test('live workflow plans component jobs and reserves the shared media budget before enqueue', async () => {
  const kv = new MockKV()
  const cachedAt = Math.floor(Date.now() / 1000) - 9 * 24 * 60 * 60
  for (let subjectId = 1; subjectId <= 100; subjectId++) kv.seedCompleteSubject(subjectId, cachedAt)
  const queueMessages: unknown[] = []
  const step = new FakeStep(kv)
  const coordinator = new MockSnapshotCoordinator(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 100, data: Array.from({ length: 50 }, (_, index) => collection(Number(new URL(text).searchParams.get('offset')) + index + 1)) })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    const result = await runSyncWorkflow(workflowEnv(kv, queueMessages, coordinator), {
      instanceId: 'live-1',
      payload: { mode: 'live', source: 'manual' },
      schedule: undefined,
    }, step, (message) => new TestNonRetryableError(message))

    assert.deepEqual(step.names.filter((name) => name.startsWith('plan-refresh-')), Array.from({ length: 10 }, (_, index) => `plan-refresh-${index}`))
    const refreshInputs = [...kv.values.entries()]
      .filter(([key]) => key.includes(':refresh-inputs'))
      .flatMap(([, value]) => value as unknown[])
    assert.equal(refreshInputs.length, 100)
    assert.equal(coordinator.reservations.length, 1)
    assert.equal(coordinator.reservations[0].date, new Date(Date.now()).toISOString().slice(0, 10))
    assert.equal(coordinator.reservations[0].reservation_id, 'live-1:media')
    assert.equal(coordinator.reservations[0].requested, 50)
    assert.equal(coordinator.reservations[0].privileged_requested, 0)
    assert.equal(coordinator.reservations[0].jobs.length, 50)
    assert.deepEqual(kv.subjectPuts(), [])
    assert.equal([...kv.apiCallsByStep.values()].every((calls) => calls <= 50), true)
    assert.equal([...kv.apiCallsByStep.entries()].filter(([name]) => name.startsWith('plan-refresh-')).every(([, calls]) => calls <= 50), true)
    assert.equal(kv.apiCallsByStep.get('reserve-media') ?? 0, 0)
    assert.equal(kv.externalCallsByStep.get('reserve-media'), 1)
    assert.equal([...kv.apiCallsByStep.entries()].filter(([name]) => name.startsWith('enqueue-refresh-')).every(([, calls]) => calls === 0), true)
    assert.equal([...kv.apiCallsByStep.values()].reduce((total, calls) => total + calls, 0) < 500, true)
    assert.equal(step.outputSizes.every((size) => size < 1024 * 1024), true)
    assert.equal((kv.values.get('snapshot:active') as any).instance_id, 'live-1')
    assert.equal((kv.values.get('snapshot:active') as any).generation, 7)
    assert.equal(queueMessages.length, 50)
    assert.equal(new Set((queueMessages as any[]).map((job) => job.job_id)).size, 50)
    assert.equal((queueMessages as any[]).every((job) => job.version === 3 && job.generation === 7), true)
    assert.equal((queueMessages as any[]).every((job) => assert.deepEqual(job.components, ['detail', 'meta', 'image_common', 'image_large']) === undefined), true)
    assert.deepEqual(result, {
      instance_id: 'live-1',
      status: 'ok',
      subject_count: 100,
      refresh_jobs: 50,
      refresh_candidates: 100,
      refresh_candidates_by_priority: { new_or_changed: 0, hot: 100, cold: 0, retry: 0 },
      refresh_selected: 50,
      refresh_granted: 50,
      refresh_deferred: 50,
      refresh_confirmed: 50,
      refresh_uncertain: 0,
      refresh_skipped: 0,
    })
    assert.deepEqual(kv.values.get('sync:run:live-1'), {
      ...(kv.values.get('sync:run:live-1') as Record<string, unknown>),
      refresh_candidates: 100,
      refresh_candidates_by_priority: { new_or_changed: 0, hot: 100, cold: 0, retry: 0 },
      refresh_selected: 50,
      refresh_granted: 50,
      refresh_deferred: 50,
      refresh_confirmed: 50,
      refresh_uncertain: 0,
      refresh_skipped: 0,
    })
    const lastEnqueueIndex = Math.max(...step.names.map((name, index) => name.startsWith('enqueue-refresh-') ? index : -1))
    assert.equal(step.names.indexOf('commit-live-snapshot') > lastEnqueueIndex, true)
    assert.equal((kv.values.get('sync:current') as any).instance_id, 'live-1')

    const putCount = kv.puts.length
    await runSyncWorkflow(workflowEnv(kv, queueMessages, coordinator), {
      instanceId: 'live-1',
      payload: { mode: 'live', source: 'manual' },
      schedule: undefined,
    }, step, (message) => new TestNonRetryableError(message))
    assert.equal(kv.puts.length, putCount)
    assert.equal(queueMessages.length, 50)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('live workflow commits the snapshot when media budget grants zero', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const coordinator = new MockSnapshotCoordinator(kv, 9, 0)
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 1, data: [collection(1)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    const result = await runSyncWorkflow(workflowEnv(kv, queueMessages, coordinator), {
      instanceId: 'budget-exhausted',
      payload: { mode: 'live', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message))

    assert.equal(coordinator.reservations.length, 1)
    assert.equal(coordinator.reservations[0].reservation_id, 'budget-exhausted:media')
    assert.equal(coordinator.reservations[0].requested, 1)
    assert.equal(coordinator.reservations[0].privileged_requested, 1)
    assert.equal(queueMessages.length, 0)
    assert.deepEqual(result, {
      instance_id: 'budget-exhausted',
      status: 'ok',
      subject_count: 1,
      refresh_jobs: 0,
      refresh_candidates: 1,
      refresh_candidates_by_priority: { new_or_changed: 1, hot: 0, cold: 0, retry: 0 },
      refresh_selected: 1,
      refresh_granted: 0,
      refresh_deferred: 1,
      refresh_confirmed: 0,
      refresh_uncertain: 0,
      refresh_skipped: 0,
    })
    assert.equal(coordinator.commits.length, 1)
    assert.equal((kv.values.get('snapshot:active') as any).instance_id, 'budget-exhausted')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('live workflow retries a lost coordinator response without reserving or enqueueing twice', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const coordinator = new MockSnapshotCoordinator(kv)
  coordinator.loseNextReservationResponse = true
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 1, data: [collection(1)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    const result = await runSyncWorkflow(workflowEnv(kv, queueMessages, coordinator), {
      instanceId: 'response-loss',
      payload: { mode: 'live', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message))

    assert.equal(step.attempts.get('reserve-media'), 2)
    assert.equal(coordinator.reservations.length, 2)
    assert.equal(coordinator.consumed, 1)
    assert.equal(queueMessages.length, 1)
    assert.equal(result.refresh_jobs, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('live workflow gives mixed new and ordinary candidates only privileged hard headroom after soft is spent', async () => {
  const kv = new MockKV()
  const cachedAt = Math.floor(Date.now() / 1000) - 9 * 24 * 60 * 60
  for (let subjectId = 1; subjectId <= 50; subjectId++) kv.seedCompleteSubject(subjectId, cachedAt)
  for (let subjectId = 1; subjectId <= 10; subjectId++) kv.values.delete(`subject:detail:${subjectId}`)
  const queueMessages: unknown[] = []
  const coordinator = new MockSnapshotCoordinator(kv)
  coordinator.seedBudget(new Date().toISOString().slice(0, 10), 50)
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 50, data: Array.from({ length: 50 }, (_, index) => collection(index + 1)) })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    const result = await runSyncWorkflow(workflowEnv(kv, queueMessages, coordinator), {
      instanceId: 'mixed-priority',
      payload: { mode: 'live', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message))

    assert.equal(coordinator.reservations[0].requested, 50)
    assert.equal(coordinator.reservations[0].privileged_requested, 10)
    assert.deepEqual((queueMessages as any[]).map(({ subject_id }) => subject_id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.equal(coordinator.consumed, 60)
    assert.deepEqual(result, {
      instance_id: 'mixed-priority',
      status: 'ok',
      subject_count: 50,
      refresh_jobs: 10,
      refresh_candidates: 50,
      refresh_candidates_by_priority: { new_or_changed: 10, hot: 40, cold: 0, retry: 0 },
      refresh_selected: 50,
      refresh_granted: 10,
      refresh_deferred: 40,
      refresh_confirmed: 10,
      refresh_uncertain: 0,
      refresh_skipped: 0,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('live workflow reports hard-limited aggregate refresh counters', async () => {
  const kv = new MockKV()
  const queueMessages: unknown[] = []
  const coordinator = new MockSnapshotCoordinator(kv)
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) {
      const offset = Number(new URL(text).searchParams.get('offset'))
      const count = Math.min(50, 101 - offset)
      return Response.json({ total: 101, data: Array.from({ length: count }, (_, index) => collection(offset + index + 1)) })
    }
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    const result = await runSyncWorkflow(workflowEnv(kv, queueMessages, coordinator), {
      instanceId: 'hard-limited',
      payload: { mode: 'live', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message))

    assert.equal(queueMessages.length, 100)
    assert.deepEqual(result, {
      instance_id: 'hard-limited',
      status: 'ok',
      subject_count: 101,
      refresh_jobs: 100,
      refresh_candidates: 101,
      refresh_candidates_by_priority: { new_or_changed: 101, hot: 0, cold: 0, retry: 0 },
      refresh_selected: 100,
      refresh_granted: 100,
      refresh_deferred: 1,
      refresh_confirmed: 100,
      refresh_uncertain: 0,
      refresh_skipped: 0,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('live workflow defers one subject media-state read failure and still publishes the snapshot', async () => {
  const kv = new MockKV()
  kv.failingGets.add('subject:detail:1')
  const queueMessages: unknown[] = []
  const coordinator = new MockSnapshotCoordinator(kv)
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 2, data: [collection(1), collection(2)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await runSyncWorkflow(workflowEnv(kv, queueMessages, coordinator), {
      instanceId: 'subject-read-failure',
      payload: { mode: 'live', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message))

    const planningOutput = step.cache.get('plan-refresh-0') as any
    assert.deepEqual(planningOutput.planning_errors, [{ subject_id: 1, error: 'KV read failed for subject:detail:1' }])
    assert.deepEqual((queueMessages as any[]).map(({ subject_id }) => subject_id), [2])
    assert.equal(coordinator.commits.length, 1)
    assert.equal((kv.values.get('snapshot:active') as any).instance_id, 'subject-read-failure')
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
    const result = await runSyncWorkflow(workflowEnv(kv, queueMessages), {
      instanceId: 'unchanged-659',
      payload: { mode: 'live', source: 'manual' },
      schedule: undefined,
    }, step, (message) => new TestNonRetryableError(message))

    assert.equal(queueMessages.length, 0)
    assert.deepEqual(kv.subjectPuts(), [])
    assert.equal((kv.values.get('snapshot:active') as any).instance_id, 'unchanged-659')
    assert.deepEqual(result, {
      instance_id: 'unchanged-659',
      status: 'ok',
      subject_count: 659,
      refresh_jobs: 0,
      refresh_candidates: 0,
      refresh_candidates_by_priority: { new_or_changed: 0, hot: 0, cold: 0, retry: 0 },
      refresh_selected: 0,
      refresh_granted: 0,
      refresh_deferred: 0,
      refresh_confirmed: 0,
      refresh_uncertain: 0,
      refresh_skipped: 659,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('live workflow commits the snapshot after an ambiguous queue submission without resending logical jobs', async () => {
  const kv = new MockKV()
  const coordinatorState = {
    values: new Map<string, unknown>(),
    async get<T>(key: string) { return this.values.get(key) as T | undefined },
    async put<T>(key: string, value: T) { this.values.set(key, value) },
    async delete(key: string) { this.values.delete(key) },
  }
  const queueMessages: any[] = []
  let queueCalls = 0
  const coordinator = new SnapshotCoordinator({ storage: coordinatorState } as any, {
    AIRING_CAL_KV: kv,
    MEDIA_QUEUE: {
      sendBatch: async (messages: Array<{ body: any }>) => {
        queueCalls += 1
        queueMessages.push(...messages.map(({ body }) => body))
        throw new Error('queue response lost after accept')
      },
    },
  } as any)
  const env = workflowEnv(kv, [])
  env.SNAPSHOT_COORDINATOR = {
    getByName(name: string) {
      assert.equal(name, 'snapshot-global')
      return { fetch: (request: Request) => coordinator.fetch(request) }
    },
  }
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 1, data: [collection(1)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    const result = await runSyncWorkflow(env, {
      instanceId: 'live-enqueue-failure',
      payload: { mode: 'live', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message))

    assert.deepEqual(result, {
      instance_id: 'live-enqueue-failure',
      status: 'ok',
      subject_count: 1,
      refresh_jobs: 1,
      refresh_candidates: 1,
      refresh_candidates_by_priority: { new_or_changed: 1, hot: 0, cold: 0, retry: 0 },
      refresh_selected: 1,
      refresh_granted: 1,
      refresh_deferred: 0,
      refresh_confirmed: 0,
      refresh_uncertain: 1,
      refresh_skipped: 0,
    })
    assert.equal(queueCalls, 1)
    assert.equal(queueMessages.length, 1)
    assert.equal((kv.values.get('snapshot:active') as any).instance_id, 'live-enqueue-failure')
    assert.deepEqual(coordinatorState.values.get('mediaBudget'), {
      date: new Date().toISOString().slice(0, 10),
      consumed: 1,
    })
    assert.equal((coordinatorState.values.get('mediaReservation:live-enqueue-failure:media') as any).submission, 'uncertain')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shadow workflow reports every prepared subject as skipped without planning or reserving', async () => {
  const kv = new MockKV()
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 2, data: [collection(1), collection(2)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    const result = await runSyncWorkflow(workflowEnv(kv, []), {
      instanceId: 'shadow-counters',
      payload: { mode: 'shadow', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message))

    assert.deepEqual(result, {
      instance_id: 'shadow-counters',
      status: 'ok',
      subject_count: 2,
      refresh_jobs: 0,
      refresh_candidates: 0,
      refresh_candidates_by_priority: { new_or_changed: 0, hot: 0, cold: 0, retry: 0 },
      refresh_selected: 0,
      refresh_granted: 0,
      refresh_deferred: 0,
      refresh_confirmed: 0,
      refresh_uncertain: 0,
      refresh_skipped: 2,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('shadow workflow runs the D1 incremental adapter after preserving legacy snapshot publication', async () => {
  const kv = new MockKV()
  const step = new FakeStep(kv)
  const calls: Array<{ instanceId: string; observedAt: number; complete: boolean; legacyPublished: boolean }> = []
  const env = {
    ...workflowEnv(kv, []),
    AIRING_CAL_D1: {} as never,
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 1, data: [collection(1)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await runSyncWorkflow(env, {
      instanceId: 'shadow-d1',
      payload: { mode: 'shadow', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message), {
      runD1IncrementalSync: async ({ instanceId, completeInput }) => {
        calls.push({
          instanceId,
          observedAt: completeInput.observedAt,
          complete: completeInput.complete,
          legacyPublished: kv.values.has('snapshot:shadow:shadow-d1:summary'),
        })
        return {
          rowsWritten: 1,
          firstMissing: 0,
          deleted: 0,
          restored: 0,
          publicationInput: {
            collections: [],
            calendar: [],
            published_at: completeInput.observedAt,
            content_hash: 'a'.repeat(64),
          },
          media: { candidates: 0, granted: 0, confirmed: 0, uncertain: 0, deferred: 0 },
          runId: instanceId,
        }
      },
    })

    assert.deepEqual(calls, [{
      instanceId: 'shadow-d1',
      observedAt: (kv.values.get('sync:run:shadow-d1') as { started_at: number }).started_at,
      complete: true,
      legacyPublished: true,
    }])
    assert.equal(step.names.includes('persist-d1-shadow'), true)
    assert.equal(kv.subjectPuts().length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('post-reservation snapshot failure persists the latest truthful counters on the error run', async () => {
  const kv = new MockKV()
  const coordinator = new MockSnapshotCoordinator(kv)
  coordinator.failCommit = true
  const step = new FakeStep(kv)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url)
    if (text.includes('/collections?')) return Response.json({ total: 1, data: [collection(1)] })
    if (text.endsWith('/calendar')) return Response.json([])
    throw new Error(`unexpected fetch ${text}`)
  }) as typeof globalThis.fetch

  try {
    await assert.rejects(() => runSyncWorkflow(workflowEnv(kv, [], coordinator), {
      instanceId: 'post-reservation-error',
      payload: { mode: 'live', source: 'manual' },
    }, step, (message) => new TestNonRetryableError(message)), /Snapshot coordinator \/commit failed \(503\)/)

    assert.deepEqual(kv.values.get('sync:run:post-reservation-error'), {
      ...(kv.values.get('sync:run:post-reservation-error') as Record<string, unknown>),
      status: 'error',
      stage: 'enqueue',
      subject_count: 1,
      refresh_jobs: 1,
      refresh_candidates: 1,
      refresh_candidates_by_priority: { new_or_changed: 1, hot: 0, cold: 0, retry: 0 },
      refresh_selected: 1,
      refresh_granted: 1,
      refresh_deferred: 0,
      refresh_confirmed: 1,
      refresh_uncertain: 0,
      refresh_skipped: 0,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
