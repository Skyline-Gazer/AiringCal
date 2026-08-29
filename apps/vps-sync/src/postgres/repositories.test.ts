import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  PostgresAuthority,
  type CompleteStateInput,
  type MediaResultInput,
  type PendingPublicationInput,
} from './repositories.ts'

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[]
  rowCount: number
}

type QueryCall = {
  sql: string
  values: readonly unknown[]
}

type StoredCollection = {
  deletedAt: string | null
  missingRunId: string | null
  missingSince: string | null
}

type StoredMedia = {
  detail: unknown
  observedAt: string
  runId: string
}

type StoredPublication = {
  verifiedGeneration: number
  verifiedContentHash: string | null
  verifiedObjectKey: string | null
  verifiedAt: string | null
  verifiedRunId: string | null
  pendingGeneration: number | null
  pendingContentHash: string | null
  pendingObjectKey: string | null
  pendingRunId: string | null
  pendingClaimedAt: string | null
  pendingCreatedAt: string | null
}

class RecordingDatabase {
  readonly collections = new Map<string, StoredCollection>()
  readonly media = new Map<number, StoredMedia>()
  readonly calls: QueryCall[] = []
  publication: StoredPublication = {
    verifiedGeneration: 0,
    verifiedContentHash: null,
    verifiedObjectKey: null,
    verifiedAt: null,
    verifiedRunId: null,
    pendingGeneration: null,
    pendingContentHash: null,
    pendingObjectKey: null,
    pendingRunId: null,
    pendingClaimedAt: null,
    pendingCreatedAt: null,
  }
}

class RecordingClient {
  released = false
  failOn?: string

  constructor(readonly database: RecordingDatabase) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.database.calls.push({ sql: normalized, values })
    if (this.failOn && normalized.includes(this.failOn)) throw new Error('injected database failure')

    if (normalized.startsWith('INSERT INTO collection_items')) {
      const key = `${String(values[0])}:${Number(values[1])}`
      this.database.collections.set(key, {
        deletedAt: null,
        missingRunId: null,
        missingSince: null,
      })
      return empty<Row>(1)
    }

    if (normalized.startsWith('UPDATE collection_items') && normalized.includes('missing_run_id')) {
      const userId = String(values[0])
      const runId = String(values[1])
      const observedAt = String(values[2])
      const observedSubjectIds = new Set((values[3] as readonly string[]).map(Number))
      for (const [key, item] of this.database.collections) {
        const [storedUserId, storedSubjectId] = key.split(':')
        if (storedUserId !== userId || observedSubjectIds.has(Number(storedSubjectId)) || item.deletedAt) continue
        if (item.missingRunId && item.missingRunId !== runId) item.deletedAt = observedAt
        if (!item.missingSince) item.missingSince = observedAt
        if (!item.missingRunId) item.missingRunId = runId
      }
      return empty<Row>()
    }

    if (normalized.startsWith('INSERT INTO subject_media')) {
      const subjectId = Number(values[0])
      const incoming: StoredMedia = {
        detail: values[1],
        observedAt: String(values[8]),
        runId: String(values[9]),
      }
      const current = this.database.media.get(subjectId)
      const accepted = !current
        || incoming.observedAt > current.observedAt
        || (incoming.observedAt === current.observedAt && incoming.runId === current.runId)
      if (!accepted) return empty<Row>()
      this.database.media.set(subjectId, {
        detail: incoming.detail ?? current?.detail ?? null,
        observedAt: incoming.observedAt,
        runId: incoming.runId,
      })
      return { rows: [{ subject_id: subjectId } as unknown as Row], rowCount: 1 }
    }

    if (normalized.includes('FROM publications') && normalized.includes('FOR UPDATE')) {
      return { rows: [publicationRow(this.database.publication) as unknown as Row], rowCount: 1 }
    }

    if (normalized === 'SELECT * FROM publications WHERE id = true') {
      return { rows: [publicationRow(this.database.publication) as unknown as Row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE publications SET pending_generation')) {
      Object.assign(this.database.publication, {
        pendingGeneration: Number(values[0]),
        pendingContentHash: String(values[1]),
        pendingObjectKey: String(values[2]),
        pendingRunId: String(values[3]),
        pendingClaimedAt: values[4] === null ? null : String(values[4]),
        pendingCreatedAt: String(values[5]),
      })
      return { rows: [publicationRow(this.database.publication) as unknown as Row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE publications SET verified_generation')) {
      const publication = this.database.publication
      const matches = publication.pendingGeneration === Number(values[0])
        && publication.pendingContentHash === String(values[1])
        && publication.pendingObjectKey === String(values[2])
      if (!matches) return empty<Row>()
      Object.assign(publication, {
        verifiedGeneration: Number(values[0]),
        verifiedContentHash: String(values[1]),
        verifiedObjectKey: String(values[2]),
        verifiedAt: String(values[3]),
        verifiedRunId: publication.pendingRunId,
        pendingGeneration: null,
        pendingContentHash: null,
        pendingObjectKey: null,
        pendingRunId: null,
        pendingClaimedAt: null,
        pendingCreatedAt: null,
      })
      return { rows: [publicationRow(publication) as unknown as Row], rowCount: 1 }
    }

    if (normalized.startsWith('SELECT s.id AS subject_id')) {
      return {
        rows: [{
          subject_id: '17',
          observed_at: '2026-08-28T02:00:00.000Z',
          observed_run_id: RUN_1,
          next_retry_at: null,
        } as unknown as Row],
        rowCount: 1,
      }
    }

    return empty<Row>()
  }

  release(): void {
    this.released = true
  }
}

class RecordingPool {
  readonly database = new RecordingDatabase()
  readonly clients: RecordingClient[] = []

  async connect(): Promise<RecordingClient> {
    const client = new RecordingClient(this.database)
    this.clients.push(client)
    return client
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const client = new RecordingClient(this.database)
    return client.query<Row>(sql, values)
  }
}

function empty<Row extends Record<string, unknown>>(rowCount = 0): QueryResult<Row> {
  return { rows: [], rowCount }
}

function publicationRow(value: StoredPublication): Record<string, unknown> {
  return {
    verified_generation: String(value.verifiedGeneration),
    verified_content_hash: value.verifiedContentHash,
    verified_object_key: value.verifiedObjectKey,
    verified_at: value.verifiedAt,
    verified_run_id: value.verifiedRunId,
    pending_generation: value.pendingGeneration === null ? null : String(value.pendingGeneration),
    pending_content_hash: value.pendingContentHash,
    pending_object_key: value.pendingObjectKey,
    pending_run_id: value.pendingRunId,
    pending_claimed_at: value.pendingClaimedAt,
    pending_created_at: value.pendingCreatedAt,
  }
}

const USER_ID = '10000000-0000-4000-8000-000000000001'
const RUN_1 = '20000000-0000-4000-8000-000000000001'
const RUN_2 = '20000000-0000-4000-8000-000000000002'
const RUN_3 = '20000000-0000-4000-8000-000000000003'

function asPool(pool: RecordingPool) {
  return pool as never
}

function completeState(
  runId: string,
  observedAt: string,
  observedSubjectIds: readonly number[],
): CompleteStateInput {
  return {
    runId,
    observedAt,
    users: [{
      id: USER_ID,
      upstreamUserId: '42',
      items: observedSubjectIds.map((subjectId) => ({
        subject: {
          id: subjectId,
          subjectType: 2,
          payload: { id: subjectId, name: `subject-${subjectId}` },
          contentHash: `subject-hash-${subjectId}`,
          upstreamUpdatedAt: null,
        },
        collection: {
          payload: { type: 2, ep_status: 3 },
          contentHash: `collection-hash-${subjectId}`,
          upstreamUpdatedAt: null,
        },
      })),
    }],
    calendarEntries: observedSubjectIds.map((subjectId) => ({
      weekdayId: 1,
      subjectId,
      payload: { weekday: { id: 1 }, subject_id: subjectId },
    })),
  }
}

function mediaResult(overrides: Partial<MediaResultInput> = {}): MediaResultInput {
  return {
    subjectId: 1,
    detail: { name: 'new' },
    metadata: null,
    imageRefs: null,
    detailHash: 'detail-hash',
    metadataHash: null,
    imageHash: null,
    status: { detail: 'success' },
    observedAt: '2026-08-28T03:00:00.000Z',
    runId: RUN_2,
    nextRetryAt: null,
    deletedAt: null,
    lastSuccessAt: '2026-08-28T03:00:00.000Z',
    ...overrides,
  }
}

function pending(overrides: Partial<PendingPublicationInput> = {}): PendingPublicationInput {
  return {
    generation: 1,
    contentHash: 'a'.repeat(64),
    objectKey: `public/snapshots/1-${'a'.repeat(64)}.json`,
    runId: RUN_1,
    claimedAt: null,
    createdAt: '2026-08-28T04:00:00.000Z',
    ...overrides,
  }
}

test('rolls back the complete-state transaction and releases its client on a write failure', async () => {
  const pool = new RecordingPool()
  const authority = new PostgresAuthority(asPool(pool))
  const client = await pool.connect()
  client.failOn = 'DELETE FROM calendar_entries'
  pool.connect = async () => client

  await assert.rejects(
    () => authority.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])),
    /injected database failure/,
  )

  const statements = pool.database.calls.map((call) => call.sql)
  assert.equal(statements[0], 'BEGIN')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
  assert.equal(client.released, true)
})

test('confirms deletion only on a second distinct complete observation and restoration clears missing state', async () => {
  const pool = new RecordingPool()
  const authority = new PostgresAuthority(asPool(pool))

  await authority.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1]))
  await authority.commitCompleteState(completeState(RUN_2, '2026-08-28T02:00:00.000Z', []))
  assert.deepEqual(pool.database.collections.get(`${USER_ID}:1`), {
    deletedAt: null,
    missingRunId: RUN_2,
    missingSince: '2026-08-28T02:00:00.000Z',
  })

  await authority.commitCompleteState(completeState(RUN_3, '2026-08-28T03:00:00.000Z', []))
  assert.equal(pool.database.collections.get(`${USER_ID}:1`)?.deletedAt, '2026-08-28T03:00:00.000Z')

  await authority.commitCompleteState(completeState(RUN_3, '2026-08-28T04:00:00.000Z', [1]))
  assert.deepEqual(pool.database.collections.get(`${USER_ID}:1`), {
    deletedAt: null,
    missingRunId: null,
    missingSince: null,
  })
})

test('rejects an older media result without replacing last-known-good state', async () => {
  const pool = new RecordingPool()
  const authority = new PostgresAuthority(asPool(pool))

  assert.equal(await authority.applyMediaResult(mediaResult()), true)
  assert.equal(await authority.applyMediaResult(mediaResult({
    detail: { name: 'stale' },
    observedAt: '2026-08-28T02:00:00.000Z',
    runId: RUN_1,
  })), false)
  assert.deepEqual(pool.database.media.get(1)?.detail, { name: 'new' })

  const mediaWrite = pool.database.calls.find((call) => call.sql.startsWith('INSERT INTO subject_media'))
  assert.match(mediaWrite?.sql ?? '', /observed_run_id/)
  assert.match(mediaWrite?.sql ?? '', /subject_media\.observed_at < EXCLUDED\.observed_at/)
})

test('lists due media with its persisted observation fence', async () => {
  const pool = new RecordingPool()
  const authority = new PostgresAuthority(asPool(pool))

  const candidates = await authority.listDueMedia({
    now: '2026-08-28T04:00:00.000Z',
    limit: 10,
  })

  assert.deepEqual(candidates, [{
    subjectId: 17,
    observedAt: '2026-08-28T02:00:00.000Z',
    runId: RUN_1,
    nextRetryAt: null,
  }])
})

test('replays an exact pending publication, permits unclaimed replacement, and rejects conflicts', async () => {
  const pool = new RecordingPool()
  const authority = new PostgresAuthority(asPool(pool))
  const first = pending()

  assert.equal((await authority.savePendingPublication(first)).pendingContentHash, first.contentHash)
  const writesAfterFirst = pool.database.calls.filter((call) => call.sql.startsWith('UPDATE publications SET pending_generation')).length
  assert.equal((await authority.savePendingPublication(first)).pendingContentHash, first.contentHash)
  assert.equal(
    pool.database.calls.filter((call) => call.sql.startsWith('UPDATE publications SET pending_generation')).length,
    writesAfterFirst,
  )

  const replacement = pending({ contentHash: 'b'.repeat(64), objectKey: `public/snapshots/1-${'b'.repeat(64)}.json`, runId: RUN_2 })
  assert.equal((await authority.savePendingPublication(replacement)).pendingContentHash, replacement.contentHash)

  pool.database.publication.pendingClaimedAt = '2026-08-28T04:10:00.000Z'
  await assert.rejects(
    () => authority.savePendingPublication(pending({ contentHash: 'c'.repeat(64), objectKey: `public/snapshots/1-${'c'.repeat(64)}.json` })),
    /PUBLICATION_GENERATION_CONFLICT/,
  )
  await assert.rejects(
    () => authority.savePendingPublication(pending({ generation: 2 })),
    /PUBLICATION_GENERATION_CONFLICT/,
  )
})

test('verifies only the matching pending publication and advances exactly one generation', async () => {
  const pool = new RecordingPool()
  const authority = new PostgresAuthority(asPool(pool))
  const candidate = pending()
  await authority.savePendingPublication(candidate)

  const state = await authority.verifyPublication({
    generation: candidate.generation,
    contentHash: candidate.contentHash,
    objectKey: candidate.objectKey,
    verifiedAt: '2026-08-28T05:00:00.000Z',
  })
  assert.equal(state.verifiedGeneration, 1)
  assert.equal(state.pendingGeneration, null)
  assert.deepEqual(await authority.getPublicationState(), state)

  await assert.rejects(
    () => authority.verifyPublication({
      generation: 2,
      contentHash: 'd'.repeat(64),
      objectKey: `public/snapshots/2-${'d'.repeat(64)}.json`,
      verifiedAt: '2026-08-28T06:00:00.000Z',
    }),
    /PUBLICATION_GENERATION_CONFLICT/,
  )
})

test('persists only the sanitized run error projection and parameterizes every business value', async () => {
  const secret = 'repository-test-secret-do-not-store'
  const pool = new RecordingPool()
  const authority = new PostgresAuthority(asPool(pool))

  await authority.beginRun({
    id: RUN_1,
    source: 'scheduled',
    mode: 'shadow',
    stage: 'collection',
    status: 'running',
    startedAt: '2026-08-28T01:00:00.000Z',
    heartbeatAt: '2026-08-28T01:00:00.000Z',
    gitSha: 'a'.repeat(40),
  })
  await authority.finishRun({
    id: RUN_1,
    stage: 'finished',
    status: 'failed',
    heartbeatAt: '2026-08-28T02:00:00.000Z',
    finishedAt: '2026-08-28T02:00:00.000Z',
    counts: { users: 1 },
    stageDurations: { collection: 100 },
    sanitizedError: {
      category: 'upstream',
      code: 'UPSTREAM_FAILURE',
      attemptCount: 3,
      stage: 'collection',
      message: secret,
      authorization: `Bearer ${secret}`,
    } as never,
    components: { publication: 'not_attempted' },
  })

  const serializedCalls = JSON.stringify(pool.database.calls)
  assert.equal(serializedCalls.includes(secret), false)
  for (const call of pool.database.calls.filter((entry) => entry.values.length > 0)) {
    assert.match(call.sql, /\$\d/)
    assert.equal(call.sql.includes(RUN_1), false)
  }
})

test('declares run fences after sync_runs so deletion and media observations remain referentially valid', async () => {
  const sql = await readFile(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8')

  assert.ok(sql.indexOf('CREATE TABLE sync_runs') < sql.indexOf('CREATE TABLE collection_items'))
  assert.match(sql, /missing_run_id uuid REFERENCES sync_runs\(id\)/)
  assert.match(sql, /CHECK \(\(missing_since IS NULL\) = \(missing_run_id IS NULL\)\)/)
  assert.match(sql, /observed_run_id uuid REFERENCES sync_runs\(id\)/)
  assert.match(sql, /CHECK \(\(observed_at IS NULL\) = \(observed_run_id IS NULL\)\)/)
})
