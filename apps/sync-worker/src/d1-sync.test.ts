import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPublicSnapshot } from '@airing-cal/domain'
import {
  sha256Canonical,
  StaleCollectionDiffError,
  type BudgetReservationRequest,
  type BudgetReservationResult,
  type CollectionDiffPlanLike,
  type CollectionRow,
  type SyncRunCompletion,
  type SyncRunFailure,
  type SyncRunRow,
  type SyncRunUpdate,
  type SubjectMediaRow,
} from '@airing-cal/storage'
import type { CompleteFullFetch } from './full-fetch-boundary.ts'
import {
  runD1IncrementalSync,
  type D1IncrementalSyncStore,
} from './d1-sync.ts'

const observedAt = 1_785_104_400

function collection(subjectId = 1, userId = 'alice', rate = 7) {
  return {
    user_id: userId,
    collection: {
      subject_id: subjectId,
      subject_type: 2,
      rate,
      type: 3,
      comment: '',
      tags: [],
      ep_status: 1,
      vol_status: 0,
      updated_at: '2026-07-27T00:00:00Z',
      private: false,
      subject: {
        id: subjectId,
        type: 2,
        name: `Subject ${subjectId}`,
        name_cn: '',
        summary: '',
        nsfw: false,
        date: '2026-07-01',
        eps: 12,
        total_episodes: 12,
        images: { common: '', large: '', medium: '', small: '', grid: '' },
        rating: { score: 0, rank: 0, total: 0 },
      },
    },
  }
}

function completeInput(entries = [collection()]): CompleteFullFetch {
  return {
    collections: entries.map(({ user_id, collection }) => ({ user_id, collection })),
    calendar: [],
    observedAt,
    complete: true,
  }
}

class RecordingStore implements D1IncrementalSyncStore {
  rows: CollectionRow[] = []
  listCalls = 0
  applied: CollectionDiffPlanLike[] = []
  started: SyncRunRow[] = []
  updated: SyncRunUpdate[] = []
  completed: SyncRunCompletion[] = []
  failed: SyncRunFailure[] = []
  currentRun: SyncRunRow | undefined
  mediaRows: SubjectMediaRow[] = []
  appState = new Map<string, unknown>()
  staleOnce = false
  applyError: Error | null = null
  crashOnNextMediaList = false
  loseFailurePersistenceOnce = false
  collectionMutations = 0
  loseUpdateResponseOnce = false
  loseCompleteResponseOnce = false
  reservation: BudgetReservationResult = {
    granted: 0,
    consumed: 0,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'submitted',
  }

  async listCollectionRows() {
    this.listCalls++
    return structuredClone(this.rows)
  }
  async listSubjectMediaRows() {
    if (this.crashOnNextMediaList) {
      this.crashOnNextMediaList = false
      throw new Error('simulated process crash after collection commit')
    }
    return structuredClone(this.mediaRows)
  }
  async getAppState<T>(key: string, decode: (value: unknown) => T) {
    const value = this.appState.get(key)
    return value === undefined ? undefined : decode(value)
  }
  async putAppState<T>(key: string, value: T) { this.appState.set(key, structuredClone(value)) }

  async applyCollectionDiff(
    plan: CollectionDiffPlanLike,
    checkpoint?: { instanceId: string; update: SyncRunUpdate },
  ) {
    this.applied.push(structuredClone(plan))
    if (this.applyError) throw this.applyError
    if (this.staleOnce) {
      this.staleOnce = false
      this.rows = structuredClone(plan.inserts)
      throw new StaleCollectionDiffError(plan.inserts[0]?.user_id ?? 'alice', plan.inserts[0]?.subject_id ?? 1)
    }
    const before = JSON.stringify(this.rows)
    const nextRows = [
      ...this.rows.filter((row) =>
        ![...plan.updates, ...plan.restored, ...plan.firstMissing, ...plan.confirmedDeleted]
          .some((next) => next.user_id === row.user_id && next.subject_id === row.subject_id)),
      ...plan.inserts.filter((insert) =>
        !this.rows.some((row) => row.user_id === insert.user_id && row.subject_id === insert.subject_id)),
      ...plan.updates,
      ...plan.restored,
      ...plan.firstMissing,
      ...plan.confirmedDeleted,
    ]
    const rowsWritten = before === JSON.stringify(nextRows)
      ? 0
      : plan.inserts.length + plan.updates.length + plan.restored.length
        + plan.firstMissing.length + plan.confirmedDeleted.length
    this.rows = nextRows
    this.collectionMutations += rowsWritten
    if (checkpoint && this.currentRun?.instance_id === checkpoint.instanceId) {
      this.currentRun = { ...this.currentRun, ...structuredClone(checkpoint.update) }
    }
    return {
      rowsWritten,
    }
  }

  async getSyncRunStatus(instanceId: string) {
    return this.currentRun?.instance_id === instanceId ? this.currentRun.status : undefined
  }
  async getSyncRun(instanceId: string) {
    return this.currentRun?.instance_id === instanceId ? structuredClone(this.currentRun) : undefined
  }
  async startSyncRun(row: SyncRunRow) {
    this.started.push(structuredClone(row))
    this.currentRun = structuredClone(row)
  }
  async updateSyncRun(_instanceId: string, update: SyncRunUpdate) {
    this.updated.push(structuredClone(update))
    if (this.currentRun) this.currentRun = { ...this.currentRun, ...structuredClone(update) }
    if (this.loseUpdateResponseOnce) {
      this.loseUpdateResponseOnce = false
      throw new Error('prepared-result update response lost after commit')
    }
  }
  async completeSyncRun(_instanceId: string, completion: SyncRunCompletion) {
    this.completed.push(structuredClone(completion))
    if (this.currentRun) this.currentRun = { ...this.currentRun, status: 'ok', stage: 'complete', ...completion }
    if (this.loseCompleteResponseOnce) {
      this.loseCompleteResponseOnce = false
      throw new Error('completion response lost after commit')
    }
    return { outcome: 'applied' as const, terminal: 'ok' as const }
  }
  async failSyncRun(_instanceId: string, failure: SyncRunFailure) {
    if (this.loseFailurePersistenceOnce) {
      this.loseFailurePersistenceOnce = false
      throw new Error('simulated process loss before failure persistence')
    }
    this.failed.push(structuredClone(failure))
    if (this.currentRun?.status === 'ok') {
      return { outcome: 'preserved_opposite_terminal' as const, terminal: 'ok' as const }
    }
    if (this.currentRun) this.currentRun = { ...this.currentRun, status: 'error', ...failure }
    return { outcome: 'applied' as const, terminal: 'error' as const }
  }
}

async function run(store: RecordingStore, input = completeInput(), submitMedia?: (
  request: BudgetReservationRequest,
) => Promise<BudgetReservationResult>, now = input.observedAt, instanceId = 'run-1') {
  return runD1IncrementalSync({
    env: {},
    instanceId,
    completeInput: input,
    now,
    store,
    submitMedia: submitMedia ?? (async () => store.reservation),
  })
}

test('unchanged input writes no collection rows while changed input writes exactly one', async () => {
  const store = new RecordingStore()
  const initial = await run(store, completeInput(), undefined, observedAt, 'initial')
  assert.equal(initial.rowsWritten, 1)

  const unchanged = await run(store, completeInput(), undefined, observedAt + 1, 'unchanged')
  assert.equal(unchanged.rowsWritten, 0)

  const changed = await run(store, {
    ...completeInput([collection(1, 'alice', 9)]),
    observedAt: observedAt + 2,
  }, undefined, observedAt + 2, 'changed')
  assert.equal(changed.rowsWritten, 1)
})

test('partial input is rejected before a missing transition can be committed', async () => {
  const store = new RecordingStore()
  const partial = { ...completeInput([]), complete: false as const }
  await assert.rejects(run(store, partial as unknown as CompleteFullFetch), /complete full fetch/i)
  assert.equal(store.applied.length, 0)
})

test('first complete miss remains public and only the second later miss is removed', async () => {
  const store = new RecordingStore()
  await run(store, completeInput(), undefined, observedAt, 'present')

  const first = await run(store, { ...completeInput([]), observedAt: observedAt + 1 }, undefined, observedAt + 1, 'first-missing')
  assert.equal(first.firstMissing, 1)
  assert.equal(first.deleted, 0)
  assert.deepEqual(first.publicationInput.collections.map(({ subject_id }) => subject_id), [1])

  const second = await run(store, { ...completeInput([]), observedAt: observedAt + 2 }, undefined, observedAt + 2, 'confirmed-missing')
  assert.equal(second.firstMissing, 0)
  assert.equal(second.deleted, 1)
  assert.deepEqual(second.publicationInput.collections, [])
})

test('multi-user rows retain identity and the planner receives the stable observedAt', async () => {
  const store = new RecordingStore()
  const result = await run(store, completeInput([
    collection(1, 'alice'),
    collection(1, 'bob'),
  ]))

  assert.deepEqual(store.applied[0]?.inserts.map(({ user_id, first_seen_at }) => [user_id, first_seen_at]), [
    ['alice', observedAt],
    ['bob', observedAt],
  ])
  assert.equal(result.rowsWritten, 2)
  assert.equal(result.publicationInput.collections.length, 1)
})

test('run lifecycle persists exact diff and media counters', async () => {
  const store = new RecordingStore()
  store.reservation = {
    granted: 1,
    consumed: 1,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'submitted',
  }
  const result = await run(store)
  const expectedSnapshot = await buildPublicSnapshot(result.publicationInput, 0)

  assert.equal(store.started.length, 1)
  assert.equal(store.started[0]?.started_at, observedAt)
  assert.equal(store.updated.at(-1)?.collection_count, 1)
  assert.equal(store.updated.at(-1)?.changed_count, 1)
  assert.equal(store.updated.at(-1)?.media_selected_count, 1)
  assert.equal(store.updated.at(-1)?.media_granted_count, 1)
  assert.equal(store.completed.length, 1)
  assert.equal(result.publicationInput.content_hash, expectedSnapshot.content_hash)
  assert.deepEqual(result.media, {
    candidates: 1,
    granted: 1,
    confirmed: 1,
    uncertain: 0,
    deferred: 0,
  })
})

test('media budget or Queue failure cannot revoke publication eligibility', async () => {
  const store = new RecordingStore()
  const result = await run(store, completeInput(), async () => ({
    granted: 1,
    consumed: 1,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'uncertain',
  }))

  assert.match(result.publicationInput.content_hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(result.media, {
    candidates: 1,
    granted: 1,
    confirmed: 0,
    uncertain: 1,
    deferred: 0,
  })
  assert.equal(store.completed.length, 1)
})

test('default shadow mode plans media without reserving unusable budget', async () => {
  const store = new RecordingStore()
  const formalBudgetDatabase = {
    prepare() {
      throw new Error('default shadow mode touched formal D1 media budget')
    },
    async batch() {
      throw new Error('default shadow mode touched formal D1 media budget')
    },
    async exec() {
      throw new Error('default shadow mode touched formal D1 media budget')
    },
  }
  const result = await runD1IncrementalSync({
    env: { AIRING_CAL_D1: formalBudgetDatabase },
    instanceId: 'planning-only',
    completeInput: completeInput(),
    now: observedAt,
    store,
  })
  assert.equal(result.media.candidates, 1)
  assert.deepEqual(result.media, {
    candidates: 1,
    granted: 0,
    confirmed: 0,
    uncertain: 0,
    deferred: 1,
  })
})

test('calendar-only subjects remain eligible for D1 media scheduling', async () => {
  const store = new RecordingStore()
  const input: CompleteFullFetch = {
    ...completeInput([]),
    calendar: [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
      items: [{
        id: 14,
        type: 2,
        name: 'Calendar only',
        name_cn: '',
        summary: '',
        nsfw: false,
        date: '',
        eps: 0,
        images: { common: '', large: '', medium: '', small: '', grid: '' },
        rating: { score: 0, rank: 0, total: 0 },
      }],
    }],
  }
  const requests: BudgetReservationRequest[] = []
  await run(store, input, async (request) => {
    requests.push(request)
    return { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'submitted' }
  })
  assert.deepEqual(requests[0]?.jobs.map((job: any) => job.subject_id), [14])
})

test('cold watched media is eligible exactly once across seven UTC shards without an expiry gate', async () => {
  const selected: number[] = []
  for (let day = 0; day < 7; day++) {
    const store = new RecordingStore()
    await run(store, completeInput([
      { ...collection(7, 'alice'), collection: { ...collection(7, 'alice').collection, type: 2 } },
    ]), undefined, observedAt, `cold-seed-${day}`)
    store.mediaRows = [{
      subject_id: 7,
      detail_json: '{}',
      detail_hash: 'a'.repeat(64),
      media_hash: null,
      nsfw: 0,
      source_image_common_url: 'https://images.example/7/common.jpg',
      source_image_large_url: 'https://images.example/7/large.jpg',
      r2_image_common_key: null,
      r2_image_large_key: null,
      checked_at: observedAt,
      next_refresh_at: null,
      retry_count: 0,
      retry_after: null,
      error_code: null,
    }]
    const dayNow = observedAt + day * 86_400
    await run(store, { ...completeInput([
      { ...collection(7, 'alice'), collection: { ...collection(7, 'alice').collection, type: 2 } },
    ]), observedAt: dayNow }, async (request) => {
      selected.push(...request.jobs.map((job: any) => job.subject_id))
      return { granted: request.jobs.length, consumed: request.jobs.length, soft_limit: 50, hard_limit: 100, submission: 'submitted' }
    }, dayNow, `cold-day-${day}`)
  }
  assert.deepEqual(selected, [7])
})

test('unchanged due hot, current cold shard and retry rows become ordered media candidates', async () => {
  const store = new RecordingStore()
  await run(store, completeInput([
    collection(1, 'alice'),
    { ...collection(7, 'alice'), collection: { ...collection(7, 'alice').collection, type: 2 } },
    collection(3, 'alice'),
  ]), undefined, observedAt, 'media-seed')
  store.mediaRows = [1, 7, 3].map((subjectId) => ({
    subject_id: subjectId,
    detail_json: '{}',
    detail_hash: 'a'.repeat(64),
    media_hash: null,
    nsfw: 0 as const,
    source_image_common_url: `https://images.example/${subjectId}/common.jpg`,
    source_image_large_url: `https://images.example/${subjectId}/large.jpg`,
    r2_image_common_key: null,
    r2_image_large_key: null,
    checked_at: observedAt - 1,
    next_refresh_at: observedAt,
    retry_count: subjectId === 3 ? 1 : 0,
    retry_after: subjectId === 3 ? observedAt : null,
    error_code: subjectId === 3 ? 'UPSTREAM_ERROR' : null,
  }))
  const requests: BudgetReservationRequest[] = []
  await run(store, completeInput([
    collection(1, 'alice'),
    { ...collection(7, 'alice'), collection: { ...collection(7, 'alice').collection, type: 2 } },
    collection(3, 'alice'),
  ]), async (request) => {
    requests.push(request)
    return { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'submitted' }
  }, observedAt, 'media-plan')

  assert.deepEqual(requests.at(-1)?.jobs.map((job: any) => job.subject_id), [1, 7, 3])
  assert.deepEqual(store.appState.get('media:cold-cursor'), { subject_ids: [7] })
})

test('one stale diff is freshly listed and replanned; only the winning plan is published', async () => {
  const store = new RecordingStore()
  store.staleOnce = true
  const result = await run(store)

  assert.equal(store.listCalls, 2)
  assert.equal(store.applied.length, 2)
  assert.equal(store.applied[0]?.inserts.length, 1)
  assert.equal(store.applied[1]?.inserts.length, 0)
  assert.equal(result.rowsWritten, 0)
  assert.equal(result.publicationInput.collections.length, 1)
})

test('stale reconciliation is bounded and non-stale storage errors propagate with classified run codes', async () => {
  const stale = new RecordingStore()
  stale.applyCollectionDiff = async (plan) => {
    stale.applied.push(plan)
    throw new StaleCollectionDiffError('alice', 1)
  }
  await assert.rejects(run(stale), StaleCollectionDiffError)
  assert.equal(stale.applied.length, 2)
  assert.equal(stale.failed[0]?.error_code, 'STALE_COLLECTION_DIFF')

  const invalid = new RecordingStore()
  invalid.applyError = new SyntaxError('upstream body must not persist')
  await assert.rejects(run(invalid), SyntaxError)
  assert.equal(invalid.failed[0]?.error_code, 'INVALID_JSON')
  assert.doesNotMatch(JSON.stringify(invalid.failed), /upstream body/)
})

test('replay after collection commit crash returns the original result without a second mutation', async () => {
  const store = new RecordingStore()
  store.crashOnNextMediaList = true
  store.loseFailurePersistenceOnce = true
  const instanceId = 'collection-checkpoint-crash'

  await assert.rejects(
    run(store, completeInput(), undefined, observedAt, instanceId),
    /simulated process crash/,
  )
  assert.equal(store.currentRun?.status, 'running')
  assert.equal(store.collectionMutations, 1)

  const replay = await run(store, completeInput(), undefined, observedAt, instanceId)

  assert.equal(store.collectionMutations, 1)
  assert.equal(replay.rowsWritten, 1)
  assert.equal(replay.firstMissing, 0)
  assert.equal(replay.deleted, 0)
  assert.equal(replay.restored, 0)
  assert.equal(replay.publicationInput.collections[0]?.subject_id, 1)
  assert.deepEqual(replay.media, {
    candidates: 1,
    granted: 0,
    confirmed: 0,
    uncertain: 0,
    deferred: 1,
  })
})

test('terminal run replay re-enters with the stable instance without a second start or completion', async () => {
  const store = new RecordingStore()
  const first = await run(store, completeInput(), undefined, observedAt, 'terminal-replay')
  const replay = await run(store, completeInput(), undefined, observedAt, 'terminal-replay')

  assert.equal(store.started.length, 1)
  assert.equal(store.completed.length, 1)
  assert.equal(store.applied.length, 1)
  assert.deepEqual(replay, first)
})

test('terminal replay rejects malformed collection/calendar entries and a stale publication hash', async () => {
  const cases: Array<{
    name: string
    mutate(envelope: any): void
    pattern: RegExp
  }> = [
    {
      name: 'collection',
      mutate: (envelope) => { envelope.result.publicationInput.collections = [{}] },
      pattern: /Invalid prepared D1 sync publication/,
    },
    {
      name: 'calendar',
      mutate: (envelope) => { envelope.result.publicationInput.calendar = [{}] },
      pattern: /Invalid prepared D1 sync publication/,
    },
    {
      name: 'content hash',
      mutate: (envelope) => { envelope.result.publicationInput.content_hash = '0'.repeat(64) },
      pattern: /content_hash/,
    },
  ]

  for (const replayCase of cases) {
    const store = new RecordingStore()
    const instanceId = `invalid-replay-${replayCase.name}`
    await run(store, completeInput(), undefined, observedAt, instanceId)
    assert.ok(store.currentRun?.result_json)
    const envelope = JSON.parse(store.currentRun.result_json)
    replayCase.mutate(envelope)
    store.currentRun.result_json = JSON.stringify(envelope)

    await assert.rejects(
      run(store, completeInput(), undefined, observedAt, instanceId),
      replayCase.pattern,
    )
    assert.equal(store.applied.length, 1)
    assert.equal(store.completed.length, 1)
  }
})

test('running prepared-result replay completes without repeating collection work or start', async () => {
  const store = new RecordingStore()
  const prepared = await run(store, completeInput(), undefined, observedAt, 'running-replay')
  assert.ok(store.currentRun)
  store.currentRun.status = 'running'
  store.currentRun.stage = 'media'
  store.currentRun.completed_at = null
  store.applied = []
  store.started = []
  store.updated = []
  store.completed = []
  store.failed = []

  const replay = await run(store, completeInput(), undefined, observedAt, 'running-replay')

  assert.equal(store.started.length, 0)
  assert.equal(store.completed.length, 1)
  assert.equal(store.applied.length, 0)
  assert.deepEqual(replay, prepared)
})

test('completion response loss returns the persisted prepared result without a duplicate completion', async () => {
  const store = new RecordingStore()
  store.loseCompleteResponseOnce = true

  const result = await run(store, completeInput(), undefined, observedAt, 'lost-completion')

  assert.equal(result.rowsWritten, 1)
  assert.equal(store.started.length, 1)
  assert.equal(store.completed.length, 1)
  assert.equal(store.currentRun?.status, 'ok')
})

test('prepared-result update response loss recovers the checkpoint before completion', async () => {
  const store = new RecordingStore()
  store.loseUpdateResponseOnce = true

  const result = await run(store, completeInput(), undefined, observedAt, 'lost-prepared-update')

  assert.equal(result.rowsWritten, 1)
  assert.equal(store.updated.length, 1)
  assert.equal(store.completed.length, 1)
  assert.equal(store.failed.length, 0)
  assert.equal(store.currentRun?.status, 'ok')
})

test('error-terminal replay rejects without repeating start, collection work, completion or failure', async () => {
  const store = new RecordingStore()
  store.currentRun = {
    instance_id: 'error-replay',
    status: 'error',
    stage: 'collections',
    generation: null,
    collection_count: 1,
    changed_count: 0,
    missing_count: 0,
    deleted_count: 0,
    media_selected_count: 0,
    media_granted_count: 0,
    input_hash: null,
    public_hash: null,
    result_json: null,
    error_code: 'SYNC_FAILED',
    started_at: observedAt,
    heartbeat_at: observedAt,
    completed_at: observedAt,
  }

  await assert.rejects(
    run(store, completeInput(), undefined, observedAt, 'error-replay'),
    /cannot be resumed from status: error/i,
  )
  assert.equal(store.started.length, 0)
  assert.equal(store.applied.length, 0)
  assert.equal(store.completed.length, 0)
  assert.equal(store.failed.length, 0)
})

test('running instance replay rejects a different complete input before collection work', async () => {
  const store = new RecordingStore()
  const original = completeInput()
  store.currentRun = {
    instance_id: 'running-input-mismatch',
    status: 'running',
    stage: 'collections',
    generation: null,
    collection_count: 1,
    changed_count: 0,
    missing_count: 0,
    deleted_count: 0,
    media_selected_count: 0,
    media_granted_count: 0,
    input_hash: await sha256Canonical(original),
    public_hash: null,
    result_json: null,
    error_code: null,
    started_at: observedAt,
    heartbeat_at: observedAt,
    completed_at: null,
  }

  await assert.rejects(
    run(
      store,
      completeInput([collection(1, 'alice', 9)]),
      undefined,
      observedAt,
      'running-input-mismatch',
    ),
    /instance input mismatch/i,
  )
  assert.equal(store.applied.length, 0)
  assert.equal(store.completed.length, 0)
  assert.equal(store.failed.length, 0)
})

function mediaRow(
  subjectId: number,
  overrides: Partial<SubjectMediaRow> = {},
): SubjectMediaRow {
  return {
    subject_id: subjectId,
    detail_json: '{}',
    detail_hash: 'a'.repeat(64),
    media_hash: null,
    nsfw: 0,
    source_image_common_url: null,
    source_image_large_url: null,
    r2_image_common_key: null,
    r2_image_large_key: null,
    checked_at: observedAt - 1,
    next_refresh_at: null,
    retry_count: 0,
    retry_after: null,
    error_code: null,
    ...overrides,
  }
}

test('due retry bypasses cold shard filtering while future retry suppresses cold and hot scheduling', async () => {
  const utcShard = new Date(observedAt * 1000).getUTCDay()
  const coldOnShard = utcShard === 0 ? 7 : utcShard
  const coldOffShard = coldOnShard + 1

  const dueCold = new RecordingStore()
  await run(dueCold, completeInput([
    { ...collection(coldOffShard), collection: { ...collection(coldOffShard).collection, type: 2 } },
  ]), undefined, observedAt, 'due-cold-seed')
  dueCold.mediaRows = [mediaRow(coldOffShard, {
    retry_count: 1,
    retry_after: observedAt,
    error_code: 'UPSTREAM_ERROR',
  })]
  const dueRequests: BudgetReservationRequest[] = []
  const dueResult = await run(dueCold, completeInput([
    { ...collection(coldOffShard), collection: { ...collection(coldOffShard).collection, type: 2 } },
  ]), async (request) => {
    dueRequests.push(request)
    return { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'submitted' }
  }, observedAt, 'due-cold-retry')
  assert.equal(dueResult.media.candidates, 1)
  assert.deepEqual(dueRequests[0]?.jobs.map((job: any) => job.subject_id), [coldOffShard])

  const futureCold = new RecordingStore()
  await run(futureCold, completeInput([
    { ...collection(coldOnShard), collection: { ...collection(coldOnShard).collection, type: 2 } },
  ]), undefined, observedAt, 'future-cold-seed')
  futureCold.mediaRows = [mediaRow(coldOnShard, {
    retry_count: 1,
    retry_after: observedAt + 60,
    error_code: 'UPSTREAM_ERROR',
  })]
  const futureColdResult = await run(futureCold, completeInput([
    { ...collection(coldOnShard), collection: { ...collection(coldOnShard).collection, type: 2 } },
  ]), undefined, observedAt, 'future-cold-retry')
  assert.equal(futureColdResult.media.candidates, 0)

  const futureHot = new RecordingStore()
  await run(futureHot, completeInput(), undefined, observedAt, 'future-hot-seed')
  futureHot.mediaRows = [mediaRow(1, {
    next_refresh_at: observedAt - 1,
    retry_count: 1,
    retry_after: observedAt + 60,
    error_code: 'UPSTREAM_ERROR',
  })]
  const futureHotResult = await run(futureHot, completeInput(), undefined, observedAt, 'future-hot-retry')
  assert.equal(futureHotResult.media.candidates, 0)
})
