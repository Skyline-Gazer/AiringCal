import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPublicSnapshot } from '@airing-cal/domain'
import {
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
  mediaRows: SubjectMediaRow[] = []
  appState = new Map<string, unknown>()
  staleOnce = false
  applyError: Error | null = null
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
  async listSubjectMediaRows() { return structuredClone(this.mediaRows) }
  async getAppState<T>(key: string, decode: (value: unknown) => T) {
    const value = this.appState.get(key)
    return value === undefined ? undefined : decode(value)
  }
  async putAppState<T>(key: string, value: T) { this.appState.set(key, structuredClone(value)) }

  async applyCollectionDiff(plan: CollectionDiffPlanLike) {
    this.applied.push(structuredClone(plan))
    if (this.applyError) throw this.applyError
    if (this.staleOnce) {
      this.staleOnce = false
      this.rows = structuredClone(plan.inserts)
      throw new StaleCollectionDiffError(plan.inserts[0]?.user_id ?? 'alice', plan.inserts[0]?.subject_id ?? 1)
    }
    this.rows = [
      ...this.rows.filter((row) =>
        ![...plan.updates, ...plan.restored, ...plan.firstMissing, ...plan.confirmedDeleted]
          .some((next) => next.user_id === row.user_id && next.subject_id === row.subject_id)),
      ...plan.inserts,
      ...plan.updates,
      ...plan.restored,
      ...plan.firstMissing,
      ...plan.confirmedDeleted,
    ]
    return {
      rowsWritten: plan.inserts.length + plan.updates.length + plan.restored.length
        + plan.firstMissing.length + plan.confirmedDeleted.length,
    }
  }

  async startSyncRun(row: SyncRunRow) { this.started.push(structuredClone(row)) }
  async updateSyncRun(_instanceId: string, update: SyncRunUpdate) { this.updated.push(structuredClone(update)) }
  async completeSyncRun(_instanceId: string, completion: SyncRunCompletion) {
    this.completed.push(structuredClone(completion))
    return { outcome: 'applied' as const, terminal: 'ok' as const }
  }
  async failSyncRun(_instanceId: string, failure: SyncRunFailure) {
    this.failed.push(structuredClone(failure))
    return { outcome: 'applied' as const, terminal: 'error' as const }
  }
}

async function run(store: RecordingStore, input = completeInput(), submitMedia?: (
  request: BudgetReservationRequest,
) => Promise<BudgetReservationResult>) {
  return runD1IncrementalSync({
    env: {},
    instanceId: 'run-1',
    completeInput: input,
    now: observedAt,
    store,
    submitMedia: submitMedia ?? (async () => store.reservation),
  })
}

test('unchanged input writes no collection rows while changed input writes exactly one', async () => {
  const store = new RecordingStore()
  const initial = await run(store)
  assert.equal(initial.rowsWritten, 1)

  const unchanged = await run(store)
  assert.equal(unchanged.rowsWritten, 0)

  const changed = await run(store, completeInput([collection(1, 'alice', 9)]))
  assert.equal(changed.rowsWritten, 1)
})

test('partial input is rejected before a missing transition can be committed', async () => {
  const store = new RecordingStore()
  const partial = { ...completeInput([]), complete: false as const }
  await assert.rejects(run(store, partial as unknown as CompleteFullFetch), /complete full fetch/i)
  assert.equal(store.applied.length, 0)
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

test('unchanged due hot, current cold shard and retry rows become ordered media candidates', async () => {
  const store = new RecordingStore()
  await run(store, completeInput([
    collection(1, 'alice'),
    { ...collection(7, 'alice'), collection: { ...collection(7, 'alice').collection, type: 2 } },
    collection(3, 'alice'),
  ]))
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
  })

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
