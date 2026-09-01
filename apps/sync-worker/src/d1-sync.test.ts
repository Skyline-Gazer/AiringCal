import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import { buildPublicSnapshot } from '@airing-cal/domain'
import {
  canonicalJson,
  D1StateStore,
  nextSubjectRefreshAt,
  sha256Canonical,
  StaleCollectionDiffError,
  SyncRunCheckpointConflictError,
  type BudgetReservationRequest,
  type BudgetReservationResult,
  type CollectionDiffPlanLike,
  type CollectionRow,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type SyncRunCompletion,
  type SyncRunCheckpointGuard,
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

function sqliteD1Result<T = Record<string, unknown>>(changes = 0, rows: T[] = []): D1ResultLike<T> {
  return {
    results: rows,
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: rows.length,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  }
}

class SqliteD1Statement implements D1PreparedStatementLike {
  private binds: unknown[] = []

  constructor(readonly sql: string, private readonly database: DatabaseSync) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.binds = values
    return this
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.binds as SQLInputValue[]) as T | undefined) ?? null
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    const applied = this.database.prepare(this.sql).run(...this.binds as SQLInputValue[])
    return sqliteD1Result<T>(Number(applied.changes))
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return sqliteD1Result<T>(
      0,
      this.database.prepare(this.sql).all(...this.binds as SQLInputValue[]) as T[],
    )
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.database.prepare(this.sql).all(...this.binds as SQLInputValue[])
      .map((row) => Object.values(row) as T)
  }
}

class LosingMultiBatchSqliteD1 implements D1DatabaseLike {
  private readonly database = new DatabaseSync(':memory:')
  private lostResponse = false
  collectionRowsWritten = 0
  collectionBatchSizes: number[] = []

  constructor() {
    this.database.exec(readFileSync(
      new URL('../../../migrations/0001_d1_authoritative_state.sql', import.meta.url),
      'utf8',
    ))
    this.database.exec(readFileSync(
      new URL('../../../migrations/0002_sync_run_replay_result.sql', import.meta.url),
      'utf8',
    ))
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteD1Statement(sql, this.database)
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike<T>[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: D1ResultLike<T>[] = []
      for (const statement of statements) results.push(await statement.run<T>())
      this.database.exec('COMMIT')
      const collectionIndexes = statements
        .map((statement, index) => ({ sql: (statement as SqliteD1Statement).sql, index }))
        .filter(({ sql }) =>
          sql.startsWith('INSERT INTO collection_items')
          || sql.startsWith('UPDATE collection_items'))
      if (collectionIndexes.length > 0) {
        this.collectionBatchSizes.push(collectionIndexes.length)
        this.collectionRowsWritten += collectionIndexes.reduce(
          (total, { index }) => total + (results[index]?.meta.changes ?? 0),
          0,
        )
      }
      if (
        !this.lostResponse
        && collectionIndexes.length === 49
        && statements.some((statement) =>
          (statement as SqliteD1Statement).sql.startsWith('UPDATE sync_runs SET stage = ?'))
      ) {
        this.lostResponse = true
        throw new Error('simulated first collection chunk response loss after commit')
      }
      return results
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.database.exec(sql)
    return { count: 0, duration: 0 }
  }
}

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
    observedUsers: [...new Set(entries.map(({ user_id }) => user_id))],
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
  appStateVersions = new Map<string, number>()
  staleOnce = false
  applyError: Error | null = null
  crashOnNextMediaList = false
  crashBeforeCursorPersistOnce = false
  crashAfterCursorPersistOnce = false
  loseFailurePersistenceOnce = false
  collectionMutations = 0
  loseApplyResponseOnce = false
  loseApplyResponseCount = 0
  applyResponseLossCheckpoint: 'exact' | 'missing' | 'input_mismatch' = 'exact'
  loseUpdateResponseOnce = false
  failUpdateBeforePersistOnce = false
  loseCompleteResponseOnce = false
  failCompleteBeforePersistCount = 0
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
  async putAppState<T>(key: string, value: T) {
    this.appState.set(key, structuredClone(value))
  }
  async putAppStateIfNewer<T>(key: string, value: T, version: number) {
    if (key === 'media:cold-cursor' && this.crashBeforeCursorPersistOnce) {
      this.crashBeforeCursorPersistOnce = false
      throw new Error('simulated process crash before cold cursor commit')
    }
    const currentVersion = this.appStateVersions.get(key) ?? -1
    if (currentVersion > version) return false
    if (currentVersion === version && JSON.stringify(this.appState.get(key)) !== JSON.stringify(value)) {
      return false
    }
    this.appState.set(key, structuredClone(value))
    this.appStateVersions.set(key, version)
    if (key === 'media:cold-cursor' && this.crashAfterCursorPersistOnce) {
      this.crashAfterCursorPersistOnce = false
      throw new Error('simulated process crash after cold cursor commit')
    }
    return true
  }
  async deleteAppStateKeys(keys: string[]) {
    for (const key of keys) {
      this.appState.delete(key)
      this.appStateVersions.delete(key)
    }
  }

  async applyCollectionDiff(
    plan: CollectionDiffPlanLike,
    checkpoint?: {
      instanceId: string
      update: SyncRunUpdate
      guard?: SyncRunCheckpointGuard
    },
  ) {
    this.applied.push(structuredClone(plan))
    if (this.applyError) throw this.applyError
    if (
      checkpoint?.guard
      && (
        this.currentRun?.stage !== checkpoint.guard.stage
        || this.currentRun.result_json !== checkpoint.guard.result_json
      )
    ) throw new Error('Sync run checkpoint conflict')
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
    if (this.loseApplyResponseOnce || this.loseApplyResponseCount > 0) {
      this.loseApplyResponseOnce = false
      this.loseApplyResponseCount = Math.max(0, this.loseApplyResponseCount - 1)
      if (this.applyResponseLossCheckpoint === 'missing' && this.currentRun) {
        this.currentRun.result_json = null
      } else if (this.applyResponseLossCheckpoint === 'input_mismatch' && this.currentRun) {
        this.currentRun.input_hash = '0'.repeat(64)
      }
      throw new Error('collection batch response lost after commit')
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
  async updateSyncRun(
    _instanceId: string,
    update: SyncRunUpdate,
    guard?: SyncRunCheckpointGuard,
  ) {
    this.updated.push(structuredClone(update))
    if (this.failUpdateBeforePersistOnce) {
      this.failUpdateBeforePersistOnce = false
      throw new Error('media checkpoint persistence failed before commit')
    }
    if (
      guard
      && (
        this.currentRun?.stage !== guard.stage
        || this.currentRun.result_json !== guard.result_json
      )
    ) throw new Error('Sync run checkpoint conflict')
    if (this.currentRun) this.currentRun = { ...this.currentRun, ...structuredClone(update) }
    if (this.loseUpdateResponseOnce) {
      this.loseUpdateResponseOnce = false
      throw new Error('prepared-result update response lost after commit')
    }
  }
  async completeSyncRun(
    _instanceId: string,
    completion: SyncRunCompletion,
    guard?: SyncRunCheckpointGuard,
  ) {
    this.completed.push(structuredClone(completion))
    if (this.failCompleteBeforePersistCount > 0) {
      this.failCompleteBeforePersistCount--
      throw new Error('completion failed before commit')
    }
    if (
      guard
      && (
        this.currentRun?.stage !== guard.stage
        || this.currentRun.result_json !== guard.result_json
      )
    ) throw new Error('Sync run checkpoint conflict')
    if (this.currentRun) this.currentRun = { ...this.currentRun, status: 'ok', stage: 'complete', ...completion }
    if (this.loseCompleteResponseOnce) {
      this.loseCompleteResponseOnce = false
      throw new Error('completion response lost after commit')
    }
    return { outcome: 'applied' as const, terminal: 'ok' as const }
  }
  async failSyncRun(
    _instanceId: string,
    failure: SyncRunFailure,
    guard?: SyncRunCheckpointGuard,
  ) {
    if (this.loseFailurePersistenceOnce) {
      this.loseFailurePersistenceOnce = false
      throw new Error('simulated process loss before failure persistence')
    }
    if (
      guard
      && this.currentRun?.status === 'running'
      && (
        this.currentRun.stage !== guard.stage
        || this.currentRun.result_json !== guard.result_json
      )
    ) throw new SyncRunCheckpointConflictError(this.currentRun.instance_id)
    this.failed.push(structuredClone(failure))
    if (this.currentRun?.status === 'ok') {
      return { outcome: 'preserved_opposite_terminal' as const, terminal: 'ok' as const }
    }
    if (this.currentRun) this.currentRun = { ...this.currentRun, status: 'error', ...failure }
    return { outcome: 'applied' as const, terminal: 'error' as const }
  }
}

async function run(store: D1IncrementalSyncStore, input = completeInput(), submitMedia?: (
  request: BudgetReservationRequest,
) => Promise<BudgetReservationResult>, now = input.observedAt, instanceId = 'run-1') {
  const defaultSubmit = store instanceof RecordingStore
    ? async () => store.reservation
    : undefined
  return runD1IncrementalSync({
    env: {},
    instanceId,
    completeInput: input,
    now,
    store,
    submitMedia: submitMedia ?? defaultSubmit,
  })
}

async function replaceReplayArtifact(
  store: RecordingStore,
  instanceId: string,
  mutate: (envelope: any) => void,
): Promise<void> {
  assert.ok(store.currentRun?.result_json)
  const manifest = JSON.parse(store.currentRun.result_json)
  assert.equal(manifest.schema_version, 2)
  const chunks = Array.from({ length: manifest.artifact.chunk_count }, (_, index) => {
    const key = `sync:artifact:${instanceId}:${manifest.artifact.aggregate_hash}:${index}`
    const chunk = store.appState.get(key)
    assert.equal(typeof chunk, 'string')
    return chunk as string
  })
  const envelope = JSON.parse(chunks.join(''))
  mutate(envelope)
  const artifactJson = canonicalJson(envelope)
  const artifactChunks: string[] = []
  for (let offset = 0; offset < artifactJson.length; offset += 128_000) {
    artifactChunks.push(artifactJson.slice(offset, offset + 128_000))
  }
  if (artifactChunks.length === 0) artifactChunks.push('')
  const aggregateHash = await sha256Canonical(artifactJson)
  const chunkHashes = await Promise.all(artifactChunks.map((chunk) => sha256Canonical(chunk)))
  artifactChunks.forEach((chunk, index) => {
    store.appState.set(`sync:artifact:${instanceId}:${aggregateHash}:${index}`, chunk)
  })
  store.currentRun.result_json = canonicalJson({
    schema_version: 2,
    input_hash: manifest.input_hash,
    artifact: {
      kind: manifest.artifact.kind,
      aggregate_hash: aggregateHash,
      byte_length: Buffer.byteLength(artifactJson, 'utf8'),
      chunk_count: artifactChunks.length,
      chunk_hashes: chunkHashes,
    },
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

test('the next daily snapshot projects completed D1 media into collections and calendar', async () => {
  const store = new RecordingStore()
  const calendar = [{
    weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
    items: [{
      id: 1,
      type: 2,
      name: 'Calendar fallback',
      name_cn: '',
      summary: 'Calendar summary',
      nsfw: false,
      date: '2026-07-01',
      eps: 12,
      images: { common: '', large: '', medium: '', small: '', grid: '' },
      rating: { score: 0, rank: 0, total: 0 },
    }],
  }]
  const first = await run(store, { ...completeInput(), calendar }, undefined, observedAt, 'media-projection-before')
  const commonHash = 'c'.repeat(64)
  const largeHash = 'd'.repeat(64)
  const detail = {
    id: 1,
    type: 2,
    name: 'D1 detail',
    name_cn: 'D1 中文',
    summary: 'D1 summary',
    nsfw: true,
    date: '2026-07-02',
    eps: 24,
    total_episodes: 26,
    rating: { score: 8.1, rank: 12, total: 340 },
  }
  store.mediaRows = [mediaRow(1, {
    detail_json: canonicalJson(detail),
    detail_hash: await sha256Canonical(detail),
    media_hash: 'e'.repeat(64),
    nsfw: 1,
    r2_image_common_key: `images/${commonHash}/original`,
    r2_image_large_key: `images/${largeHash}/original`,
    checked_at: observedAt + 1,
    next_refresh_at: observedAt + 7 * 86_400,
  })]

  const second = await run(
    store,
    { ...completeInput(), calendar, observedAt: observedAt + 86_400 },
    undefined,
    observedAt + 86_400,
    'media-projection-after',
  )

  assert.notEqual(second.publicationInput.content_hash, first.publicationInput.content_hash)
  assert.deepEqual(second.publicationInput.collections[0], {
    subject_id: 1,
    name: 'D1 detail',
    name_cn: 'D1 中文',
    summary: 'D1 summary',
    images: {
      common: {
        hash: commonHash,
        uri: `/image/${commonHash}`,
        r2_key: `images/${commonHash}/original`,
      },
      large: {
        hash: largeHash,
        uri: `/image/${largeHash}`,
        r2_key: `images/${largeHash}/original`,
      },
    },
    image_status: { common: 'cached', large: 'cached' },
    rating: { score: 8.1, rank: 12, total: 340 },
    eps: 24,
    total_episodes: 26,
    ep_status: 1,
    vol_status: 0,
    type: 2,
    collection_type: 3,
    rate: 7,
    nsfw: true,
    date: '2026-07-02',
    tags: [],
    updated_at: '2026-07-27T00:00:00Z',
  })
  assert.deepEqual(second.publicationInput.calendar[0]?.items[0], {
    subject_id: 1,
    id: 1,
    type: 2,
    name: 'D1 detail',
    name_cn: 'D1 中文',
    summary: 'D1 summary',
    images: second.publicationInput.collections[0]?.images,
    image_status: { common: 'cached', large: 'cached' },
    nsfw: true,
    date: '2026-07-02',
    eps: 24,
    total_episodes: 26,
    rating: { score: 8.1, rank: 12, total: 340 },
  })
})

test('D1 media projection falls back for invalid detail and preserves tombstone image references', async () => {
  const store = new RecordingStore()
  const commonHash = 'a'.repeat(64)
  await run(store, completeInput(), undefined, observedAt, 'media-fallback-seed')
  store.mediaRows = [mediaRow(1, {
    detail_json: canonicalJson({ id: 999, name: 'wrong subject' }),
    detail_hash: 'b'.repeat(64),
    media_hash: 'c'.repeat(64),
    nsfw: 1,
    r2_image_common_key: `images/${commonHash}/original`,
    r2_image_large_key: 'not-an-image-object-key',
    checked_at: observedAt + 1,
    next_refresh_at: observedAt + 86_400,
  })]

  const result = await run(
    store,
    { ...completeInput(), observedAt: observedAt + 1 },
    undefined,
    observedAt + 1,
    'media-fallback',
  )

  assert.equal(result.publicationInput.collections[0]?.name, 'Subject 1')
  assert.equal(result.publicationInput.collections[0]?.eps, 12)
  assert.equal(result.publicationInput.collections[0]?.nsfw, true)
  assert.deepEqual(result.publicationInput.collections[0]?.images, {
    common: {
      hash: commonHash,
      uri: `/image/${commonHash}`,
      r2_key: `images/${commonHash}/original`,
    },
    large: null,
  })
  assert.deepEqual(result.publicationInput.collections[0]?.image_status, {
    common: 'cached',
    large: 'pending_next_cron',
  })

  store.mediaRows = [mediaRow(1, {
    detail_json: null,
    detail_hash: null,
    media_hash: 'd'.repeat(64),
    nsfw: 1,
    r2_image_common_key: `images/${commonHash}/original`,
    checked_at: observedAt + 2,
    next_refresh_at: observedAt + 86_402,
  })]
  const tombstone = await run(
    store,
    { ...completeInput(), observedAt: observedAt + 2 },
    undefined,
    observedAt + 2,
    'media-tombstone',
  )
  assert.equal(tombstone.publicationInput.collections[0]?.name, 'Subject 1')
  assert.equal(tombstone.publicationInput.collections[0]?.nsfw, true)
  assert.equal(tombstone.publicationInput.collections[0]?.images.common?.hash, commonHash)
})

test('a completed due refresh watermark suppresses the next daily hot planner run', async () => {
  const store = new RecordingStore()
  await run(store, completeInput(), undefined, observedAt, 'due-watermark-seed')
  const checkedAt = observedAt
  store.mediaRows = [mediaRow(1, {
    checked_at: checkedAt,
    next_refresh_at: nextSubjectRefreshAt(1, checkedAt),
  })]
  const nextDayRequests: BudgetReservationRequest[] = []

  const nextDay = await run(
    store,
    { ...completeInput(), observedAt: checkedAt + 86_400 },
    async (request) => {
      nextDayRequests.push(request)
      return { granted: request.jobs.length, consumed: request.jobs.length, soft_limit: 50, hard_limit: 100, submission: 'submitted' }
    },
    checkedAt + 86_400,
    'due-watermark-next-day',
  )

  assert.equal(nextDay.media.candidates, 0)
  assert.deepEqual(nextDayRequests, [])
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
  assert.equal(requests[0]?.jobs.every((job: any) => job.version === 4), true)
  assert.deepEqual(requests[0]?.jobs.map((job: any) => job.generation), [{
    observed_at: observedAt,
    run_id: 'run-1',
  }])
})

test('D1 media generation is replay-stable and ignores the retry clock', async () => {
  const capture = async (inputObservedAt: number, now: number, instanceId: string) => {
    const requests: any[] = []
    await run(new RecordingStore(), {
      ...completeInput([collection(1, 'alice'), collection(14, 'alice')]),
      observedAt: inputObservedAt,
    }, async (request) => {
      requests.push(request)
      return { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'submitted' }
    }, now, instanceId)
    return requests[0]?.jobs[0]?.generation
  }

  const first = await capture(observedAt, observedAt + 1_000, 'stable-run')
  const replay = await capture(observedAt, observedAt + 9_000, 'stable-run')
  const later = await capture(observedAt + 1, observedAt + 20_000, 'later-run')
  assert.deepEqual(first, { observed_at: observedAt, run_id: 'stable-run' })
  assert.deepEqual(replay, first)
  assert.deepEqual(later, { observed_at: observedAt + 1, run_id: 'later-run' })
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
  assert.ok(store.currentRun?.result_json)
  const manifest = JSON.parse(store.currentRun.result_json)
  const artifactKeys = [...store.appState.keys()].filter((key) =>
    key.startsWith('sync:artifact:run-1:'))
  assert.equal(artifactKeys.length, manifest.artifact.chunk_count)
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
  assert.deepEqual(
    [...stale.appState.keys()].filter((key) => key.startsWith('sync:artifact:run-1:')),
    [],
  )

  const invalid = new RecordingStore()
  invalid.applyError = new SyntaxError('upstream body must not persist')
  await assert.rejects(run(invalid), SyntaxError)
  assert.equal(invalid.failed[0]?.error_code, 'INVALID_JSON')
  assert.doesNotMatch(JSON.stringify(invalid.failed), /upstream body/)
})

test('collection apply failure removes only the newly unadopted replay artifact', async () => {
  const store = new RecordingStore()
  store.applyError = new Error('collection apply failed before checkpoint adoption')
  const instanceId = 'unadopted-collection-artifact'

  await assert.rejects(
    run(store, completeInput(), undefined, observedAt, instanceId),
    /collection apply failed before checkpoint adoption/,
  )

  const artifactKeys = [...store.appState.keys()].filter((key) =>
    key.startsWith(`sync:artifact:${instanceId}:`))
  assert.deepEqual(artifactKeys, [])
  assert.equal(store.currentRun?.result_json, null)
  assert.equal(store.currentRun?.status, 'error')
})

test('media projection read failure occurs before collection commit and replay mutates once', async () => {
  const store = new RecordingStore()
  store.crashOnNextMediaList = true
  store.loseFailurePersistenceOnce = true
  const instanceId = 'collection-checkpoint-crash'

  await assert.rejects(
    run(store, completeInput(), undefined, observedAt, instanceId),
    /simulated process crash/,
  )
  assert.equal(store.currentRun?.status, 'running')
  assert.equal(store.collectionMutations, 0)

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

test('collection checkpoint replay keeps the media projection observed before its commit', async () => {
  const store = new RecordingStore()
  const before = {
    id: 1,
    name: 'Media before checkpoint',
    name_cn: '',
    summary: '',
    date: '2026-07-01',
    eps: 12,
    total_episodes: 12,
  }
  store.mediaRows = [mediaRow(1, {
    detail_json: canonicalJson(before),
    detail_hash: await sha256Canonical(before),
    checked_at: observedAt,
  })]
  store.loseApplyResponseCount = 2
  store.loseFailurePersistenceOnce = true
  const instanceId = 'media-projection-checkpoint'

  await assert.rejects(
    run(store, completeInput(), undefined, observedAt, instanceId),
    /collection batch response lost after commit/,
  )
  assert.equal(store.currentRun?.status, 'running')
  assert.ok(store.currentRun?.result_json)

  const after = { ...before, name: 'Media changed after checkpoint' }
  store.mediaRows = [mediaRow(1, {
    detail_json: canonicalJson(after),
    detail_hash: await sha256Canonical(after),
    checked_at: observedAt + 1,
  })]
  const replay = await run(store, completeInput(), undefined, observedAt + 1, instanceId)

  assert.equal(replay.publicationInput.collections[0]?.name, 'Media before checkpoint')
  assert.equal(store.collectionMutations, 1)
})

test('collection batch response loss continues only from the exact persisted checkpoint', async () => {
  const recovered = new RecordingStore()
  recovered.loseApplyResponseOnce = true

  const result = await run(recovered, completeInput(), undefined, observedAt, 'lost-collection-response')

  assert.equal(result.rowsWritten, 1)
  assert.equal(recovered.collectionMutations, 1)
  assert.equal(recovered.applied.length, 2)
  assert.equal(recovered.failed.length, 0)
  assert.equal(recovered.currentRun?.status, 'ok')

  for (const checkpointMode of ['missing', 'input_mismatch'] as const) {
    const rejected = new RecordingStore()
    rejected.loseApplyResponseOnce = true
    rejected.applyResponseLossCheckpoint = checkpointMode

    await assert.rejects(
      run(rejected, completeInput(), undefined, observedAt, `lost-collection-${checkpointMode}`),
      /collection batch response lost after commit/,
    )
    assert.equal(rejected.collectionMutations, 1)
    assert.equal(rejected.failed.length, 1)
    assert.equal(rejected.currentRun?.status, 'error')
  }
})

test('repeated response loss preserves chunks for the exact manifest still referenced by the run', async () => {
  const store = new RecordingStore()
  store.loseApplyResponseCount = 2
  const instanceId = 'referenced-collection-artifact'

  await assert.rejects(
    run(store, completeInput(), undefined, observedAt, instanceId),
    /collection batch response lost after commit/,
  )

  assert.ok(store.currentRun?.result_json)
  const manifest = JSON.parse(store.currentRun.result_json)
  const artifactKeys = [...store.appState.keys()].filter((key) =>
    key.startsWith(`sync:artifact:${instanceId}:`))
  assert.equal(artifactKeys.length, manifest.artifact.chunk_count)
  assert.equal(store.currentRun.status, 'error')
})

test('real D1 multi-batch response loss reconciles the full checkpoint before publication', async () => {
  const database = new LosingMultiBatchSqliteD1()
  const input = completeInput(Array.from({ length: 60 }, (_, index) => collection(index + 1)))
  const instanceId = 'real-multi-batch-response-loss'

  const result = await runD1IncrementalSync({
    env: { AIRING_CAL_D1: database },
    instanceId,
    completeInput: input,
    now: observedAt,
  })
  const rows = await new D1StateStore(database).listCollectionRows()

  assert.equal(rows.length, 60)
  assert.equal(database.collectionRowsWritten, 60)
  assert.deepEqual(database.collectionBatchSizes, [49, 49, 11])
  assert.equal(result.rowsWritten, 60)
  assert.equal(result.publicationInput.collections.length, 60)
  assert.deepEqual(result.media, {
    candidates: 60,
    granted: 0,
    confirmed: 0,
    uncertain: 0,
    deferred: 60,
  })

  const replay = await runD1IncrementalSync({
    env: { AIRING_CAL_D1: database },
    instanceId,
    completeInput: input,
    now: observedAt,
  })

  assert.deepEqual(replay, result)
  assert.equal(database.collectionRowsWritten, 60)
  assert.deepEqual(database.collectionBatchSizes, [49, 49, 11])
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
    await replaceReplayArtifact(store, instanceId, replayCase.mutate)

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

test('persistent pre-commit completion failure is bounded without recursive retry', async () => {
  const store = new RecordingStore()
  store.failCompleteBeforePersistCount = 2

  await assert.rejects(
    run(store, completeInput(), undefined, observedAt, 'bounded-completion-failure'),
    /completion failed before commit/,
  )

  assert.equal(store.completed.length, 1)
  assert.equal(store.failed.length, 1)
  assert.equal(store.currentRun?.status, 'error')
  assert.equal(store.failCompleteBeforePersistCount, 1)
})

test('media-pending update response loss is reconciled before submission and completion', async () => {
  const store = new RecordingStore()
  store.loseUpdateResponseOnce = true

  const result = await run(store, completeInput(), undefined, observedAt, 'lost-prepared-update')

  assert.equal(result.rowsWritten, 1)
  assert.equal(store.updated.length, 2)
  assert.equal(store.completed.length, 1)
  assert.equal(store.failed.length, 0)
  assert.equal(store.currentRun?.status, 'ok')
})

test('media submission has zero external side effects before its pending checkpoint is adopted', async () => {
  const store = new RecordingStore()
  store.failUpdateBeforePersistOnce = true
  let submissions = 0

  await assert.rejects(
    run(store, completeInput(), async () => {
      submissions++
      return {
        granted: 1,
        consumed: 1,
        soft_limit: 50,
        hard_limit: 100,
        submission: 'submitted',
      }
    }, observedAt, 'media-checkpoint-failure'),
    /media checkpoint persistence failed before commit/,
  )

  assert.equal(submissions, 0)
  assert.equal(store.currentRun?.status, 'error')
  const retained = JSON.parse(store.currentRun!.result_json!)
  assert.equal(retained.artifact.kind, 'collection')
  assert.equal(
    [...store.appState.keys()].filter((key) =>
      key.startsWith('sync:artifact:media-checkpoint-failure:')).length,
    retained.artifact.chunk_count,
  )
})

test('accepted media submission process loss replays the frozen request and cold cursor target', async () => {
  const utcShard = new Date(observedAt * 1000).getUTCDay()
  const coldIds = Array.from({ length: 52 }, (_, index) => utcShard + 7 * (index + 1))
  const watched = coldIds.map((subjectId) => {
    const entry = collection(subjectId)
    return { ...entry, collection: { ...entry.collection, type: 2 } }
  })
  const store = new RecordingStore()
  await run(store, completeInput(watched), undefined, observedAt, 'accepted-loss-seed')
  store.mediaRows = coldIds.map((subjectId) => mediaRow(subjectId))
  store.loseFailurePersistenceOnce = true
  const requests: BudgetReservationRequest[] = []
  let queueSends = 0
  const durableResult = {
    granted: 1,
    consumed: 1,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'submitted' as const,
  }
  const submit = async (request: BudgetReservationRequest) => {
    requests.push(structuredClone(request))
    if (requests.length === 1) {
      assert.equal(JSON.parse(store.currentRun!.result_json!).artifact.kind, 'media_pending')
      queueSends++
      throw new Error('simulated process loss after accepted Queue submission')
    }
    return durableResult
  }
  const instanceId = 'accepted-media-process-loss'

  await assert.rejects(
    run(store, completeInput(watched), submit, observedAt, instanceId),
    /simulated process loss after accepted Queue submission/,
  )
  assert.equal(store.currentRun?.status, 'running')
  assert.equal(queueSends, 1)

  store.mediaRows = coldIds.map((subjectId) => mediaRow(subjectId, {
    retry_count: 1,
    retry_after: observedAt + 86_400,
    error_code: 'UPSTREAM_ERROR',
  }))
  const replay = await run(
    store,
    completeInput(watched),
    submit,
    observedAt + 60,
    instanceId,
  )

  assert.equal(queueSends, 1)
  assert.equal(requests.length, 2)
  assert.equal(JSON.stringify(requests[1]), JSON.stringify(requests[0]))
  assert.equal(await sha256Canonical(requests[1]), await sha256Canonical(requests[0]))
  assert.deepEqual(replay.media, {
    candidates: 52,
    granted: 1,
    confirmed: 1,
    uncertain: 0,
    deferred: 51,
  })
  assert.deepEqual(store.appState.get('media:cold-cursor'), { subject_ids: coldIds.slice(1) })
  assert.equal(store.currentRun?.status, 'ok')
})

test('stale collection attempt reloads a concurrently adopted real D1 media checkpoint', async () => {
  const database = new LosingMultiBatchSqliteD1()
  const store = new D1StateStore(database)
  const originalApply = store.applyCollectionDiff.bind(store)
  let releaseFirstApply!: () => void
  const firstApplyReleased = new Promise<void>((resolve) => { releaseFirstApply = resolve })
  let firstApplyAdopted!: () => void
  const firstApplyReady = new Promise<void>((resolve) => { firstApplyAdopted = resolve })
  let applyCalls = 0
  store.applyCollectionDiff = async (...args) => {
    const result = await originalApply(...args)
    applyCalls++
    if (applyCalls === 1) {
      firstApplyAdopted()
      await firstApplyReleased
    }
    return result
  }

  const durableResult = {
    granted: 1,
    consumed: 1,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'submitted' as const,
  }
  let releaseAcceptedSubmit!: () => void
  const acceptedSubmitReleased = new Promise<void>((resolve) => {
    releaseAcceptedSubmit = resolve
  })
  let firstSubmitAccepted!: () => void
  const firstSubmitReady = new Promise<void>((resolve) => { firstSubmitAccepted = resolve })
  let replaySubmitted!: () => void
  const replaySubmitReady = new Promise<void>((resolve) => { replaySubmitted = resolve })
  const requests: BudgetReservationRequest[] = []
  let queueSends = 0
  let storedResult: typeof durableResult | undefined
  const submit = async (request: BudgetReservationRequest) => {
    requests.push(structuredClone(request))
    if (!storedResult) {
      queueSends++
      storedResult = durableResult
      firstSubmitAccepted()
      await acceptedSubmitReleased
    } else {
      replaySubmitted()
    }
    return storedResult
  }
  const instanceId = 'real-d1-stage-interleaving'
  const input = completeInput()

  const staleAttempt = run(store, input, submit, observedAt, instanceId)
  await firstApplyReady
  const winningAttempt = run(store, input, submit, observedAt, instanceId)
  await firstSubmitReady
  releaseFirstApply()
  await replaySubmitReady
  releaseAcceptedSubmit()

  const [staleResult, winningResult] = await Promise.all([staleAttempt, winningAttempt])
  assert.equal(queueSends, 1)
  assert.equal(requests.length, 2)
  assert.equal(JSON.stringify(requests[1]), JSON.stringify(requests[0]))
  assert.deepEqual(staleResult.media, winningResult.media)
  assert.deepEqual(staleResult.media, {
    candidates: 1,
    granted: 1,
    confirmed: 1,
    uncertain: 0,
    deferred: 0,
  })
  const completed = await store.getSyncRun(instanceId)
  assert.equal(completed?.status, 'ok')
  assert.equal(completed?.stage, 'complete')
  assert.equal(completed?.result_json, JSON.stringify(JSON.parse(completed.result_json!)))
})

test('stale pending failure follows a concurrently prepared real D1 winner', async () => {
  const store = new D1StateStore(new LosingMultiBatchSqliteD1())
  const originalComplete = store.completeSyncRun.bind(store)
  let releaseWinnerComplete!: () => void
  const winnerCompleteReleased = new Promise<void>((resolve) => {
    releaseWinnerComplete = resolve
  })
  let winnerPrepared!: () => void
  const winnerPreparedReady = new Promise<void>((resolve) => { winnerPrepared = resolve })
  let firstCompletion = true
  store.completeSyncRun = async (...args) => {
    if (firstCompletion) {
      firstCompletion = false
      winnerPrepared()
      await winnerCompleteReleased
    }
    return originalComplete(...args)
  }

  const originalFail = store.failSyncRun.bind(store)
  let staleFailureFinished!: () => void
  const staleFailureReady = new Promise<void>((resolve) => {
    staleFailureFinished = resolve
  })
  store.failSyncRun = async (...args) => {
    try {
      return await originalFail(...args)
    } finally {
      staleFailureFinished()
    }
  }

  const durableResult = {
    granted: 1,
    consumed: 1,
    soft_limit: 50,
    hard_limit: 100,
    submission: 'submitted' as const,
  }
  let releaseStaleSubmit!: () => void
  const staleSubmitReleased = new Promise<void>((resolve) => { releaseStaleSubmit = resolve })
  let staleSubmitAccepted!: () => void
  const staleSubmitReady = new Promise<void>((resolve) => { staleSubmitAccepted = resolve })
  let queueSends = 0
  let storedResult: typeof durableResult | undefined
  const requests: BudgetReservationRequest[] = []
  const submit = async (request: BudgetReservationRequest) => {
    requests.push(structuredClone(request))
    if (!storedResult) {
      storedResult = durableResult
      queueSends++
      staleSubmitAccepted()
      await staleSubmitReleased
      throw new Error('stale attempt failed after durable acceptance')
    }
    return storedResult
  }
  const input = completeInput()
  const instanceId = 'guarded-failure-interleaving'

  const staleAttempt = run(store, input, submit, observedAt, instanceId)
  await staleSubmitReady
  const winningAttempt = run(store, input, submit, observedAt, instanceId)
  await winnerPreparedReady
  releaseStaleSubmit()
  await staleFailureReady
  releaseWinnerComplete()

  const [staleResult, winningResult] = await Promise.all([staleAttempt, winningAttempt])
  assert.equal(queueSends, 1)
  assert.equal(requests.length, 2)
  assert.equal(JSON.stringify(requests[1]), JSON.stringify(requests[0]))
  assert.deepEqual(staleResult, winningResult)
  const completed = await store.getSyncRun(instanceId)
  assert.equal(completed?.status, 'ok')
  assert.equal(completed?.stage, 'complete')
})

test('cold cursor commit crash replays the exact prepared media result without another reservation', async () => {
  const utcShard = new Date(observedAt * 1000).getUTCDay()
  const coldIds = Array.from({ length: 52 }, (_, index) => utcShard + 7 * (index + 1))
  const watched = coldIds.map((subjectId) => {
    const entry = collection(subjectId)
    return { ...entry, collection: { ...entry.collection, type: 2 } }
  })
  const store = new RecordingStore()
  await run(store, completeInput(watched), undefined, observedAt, 'cursor-crash-seed')
  store.mediaRows = coldIds.map((subjectId) => mediaRow(subjectId))
  store.crashAfterCursorPersistOnce = true
  store.loseFailurePersistenceOnce = true
  const requests: BudgetReservationRequest[] = []
  const submit = async (request: BudgetReservationRequest) => {
    requests.push(structuredClone(request))
    return { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'submitted' as const }
  }

  await assert.rejects(
    run(store, completeInput(watched), submit, observedAt, 'cursor-crash-run'),
    /simulated process crash after cold cursor commit/,
  )
  assert.equal(store.currentRun?.status, 'running')
  assert.equal(requests.length, 1)
  const originalFingerprint = await sha256Canonical(requests[0])

  const replay = await run(store, completeInput(watched), submit, observedAt, 'cursor-crash-run')

  assert.equal(await sha256Canonical(requests[0]), originalFingerprint)
  assert.equal(requests.length, 1)
  assert.deepEqual(replay.media, {
    candidates: 52,
    granted: 1,
    confirmed: 1,
    uncertain: 0,
    deferred: 51,
  })
  assert.equal(store.currentRun?.status, 'ok')
})

test('prepared replay completes a cold cursor transition interrupted before its commit', async () => {
  const utcShard = new Date(observedAt * 1000).getUTCDay()
  const coldIds = Array.from({ length: 52 }, (_, index) => utcShard + 7 * (index + 1))
  const watched = coldIds.map((subjectId) => {
    const entry = collection(subjectId)
    return { ...entry, collection: { ...entry.collection, type: 2 } }
  })
  const store = new RecordingStore()
  await run(store, completeInput(watched), undefined, observedAt, 'cursor-before-crash-seed')
  store.mediaRows = coldIds.map((subjectId) => mediaRow(subjectId))
  store.crashBeforeCursorPersistOnce = true
  store.loseFailurePersistenceOnce = true
  const requests: BudgetReservationRequest[] = []
  const submit = async (request: BudgetReservationRequest) => {
    requests.push(structuredClone(request))
    return { granted: 1, consumed: 1, soft_limit: 50, hard_limit: 100, submission: 'submitted' as const }
  }

  await assert.rejects(
    run(store, completeInput(watched), submit, observedAt, 'cursor-before-crash-run'),
    /simulated process crash before cold cursor commit/,
  )
  assert.equal(store.appState.has('media:cold-cursor'), false)
  assert.equal(requests.length, 1)

  const replay = await run(store, completeInput(watched), submit, observedAt, 'cursor-before-crash-run')

  assert.equal(requests.length, 1)
  assert.deepEqual(store.appState.get('media:cold-cursor'), { subject_ids: coldIds.slice(1) })
  assert.deepEqual(replay.media, {
    candidates: 52,
    granted: 1,
    confirmed: 1,
    uncertain: 0,
    deferred: 51,
  })
  assert.equal(store.currentRun?.status, 'ok')
})

test('older prepared replay cannot regress a newer global cold cursor', async () => {
  const utcShard = new Date(observedAt * 1000).getUTCDay()
  const coldIds = Array.from({ length: 52 }, (_, index) => utcShard + 7 * (index + 1))
  const watched = coldIds.map((subjectId) => {
    const entry = collection(subjectId)
    return { ...entry, collection: { ...entry.collection, type: 2 } }
  })
  const store = new RecordingStore()
  await run(store, completeInput(watched), undefined, observedAt, 'cursor-monotonic-seed')
  store.mediaRows = coldIds.map((subjectId) => mediaRow(subjectId))
  store.crashBeforeCursorPersistOnce = true
  store.loseFailurePersistenceOnce = true

  await assert.rejects(
    run(store, completeInput(watched), async () => ({
      granted: 1,
      consumed: 1,
      soft_limit: 50,
      hard_limit: 100,
      submission: 'submitted',
    }), observedAt, 'cursor-instance-a'),
    /simulated process crash before cold cursor commit/,
  )
  const instanceARun = structuredClone(store.currentRun)
  const newerCursor = { subject_ids: [999] }
  await store.putAppStateIfNewer('media:cold-cursor', newerCursor, observedAt + 1)
  store.currentRun = instanceARun

  const replay = await run(
    store,
    completeInput(watched),
    undefined,
    observedAt,
    'cursor-instance-a',
  )

  assert.deepEqual(store.appState.get('media:cold-cursor'), newerCursor)
  assert.equal(replay.runId, 'cursor-instance-a')
  assert.equal(store.currentRun?.status, 'ok')
})

test('replay artifacts larger than one D1 value use a bounded manifest and verified chunks', async () => {
  const summary = 'x'.repeat(45_000)
  const entries = Array.from({ length: 48 }, (_, index) => {
    const entry = collection(index + 1)
    return {
      ...entry,
      collection: {
        ...entry.collection,
        subject: { ...entry.collection.subject, summary },
      },
    }
  })
  const store = new RecordingStore()

  const result = await run(store, completeInput(entries), undefined, observedAt, 'large-artifact')

  assert.equal(result.publicationInput.collections.length, 48)
  assert.ok(store.currentRun?.result_json)
  assert.ok(Buffer.byteLength(store.currentRun.result_json, 'utf8') < 100_000)
  const manifest = JSON.parse(store.currentRun.result_json)
  assert.equal(manifest.schema_version, 2)
  assert.equal(manifest.artifact.kind, 'prepared')
  assert.ok(manifest.artifact.byte_length > 2_000_000)
  assert.ok(manifest.artifact.chunk_count > 1)
  const chunkKeys = [...store.appState.keys()].filter((key) => key.startsWith('sync:artifact:large-artifact:'))
  assert.equal(chunkKeys.length, manifest.artifact.chunk_count)
  for (const key of chunkKeys) {
    const chunk = store.appState.get(key)
    assert.equal(typeof chunk, 'string')
    assert.ok(Buffer.byteLength(canonicalJson({ schema_version: 1, value: chunk }), 'utf8') < 2_000_000)
  }
})

test('malformed running replay artifacts are classified and terminalized', async () => {
  for (const corruption of ['manifest', 'missing_chunk', 'chunk_hash'] as const) {
    const store = new RecordingStore()
    const instanceId = `malformed-artifact-${corruption}`
    await run(store, completeInput(), undefined, observedAt, instanceId)
    assert.ok(store.currentRun?.result_json)
    const artifactJson = store.currentRun.result_json
    const aggregateHash = await sha256Canonical(artifactJson)
    const chunkHash = await sha256Canonical(artifactJson)
    const inputHash = await sha256Canonical(completeInput())
    const chunkKey = `sync:artifact:${instanceId}:${aggregateHash}:0`
    store.currentRun.status = 'running'
    store.currentRun.stage = 'media'
    store.currentRun.completed_at = null
    store.currentRun.result_json = corruption === 'manifest'
      ? '{'
      : canonicalJson({
          schema_version: 2,
          input_hash: inputHash,
          artifact: {
            kind: 'prepared',
            aggregate_hash: aggregateHash,
            byte_length: Buffer.byteLength(artifactJson, 'utf8'),
            chunk_count: 1,
            chunk_hashes: [chunkHash],
          },
        })
    if (corruption === 'chunk_hash') store.appState.set(chunkKey, `${artifactJson}corrupt`)
    store.failed = []

    await assert.rejects(
      run(store, completeInput(), undefined, observedAt, instanceId),
      /artifact|checkpoint|prepared|JSON/i,
    )
    assert.equal(store.failed.length, 1)
    assert.equal(store.failed[0]?.error_code, 'SYNC_FAILED')
    assert.equal(store.currentRun.status, 'error')
  }
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
