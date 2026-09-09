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

type StoredCollectionData = {
  payload: Record<string, unknown>
  contentHash: string
  upstreamUpdatedAt: string | null
  observedAt: string
}

type StoredSubject = { contentHash: string; deletedAt: string | null }

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
  readonly collectionData = new Map<string, StoredCollectionData>()
  readonly subjects = new Map<number, StoredSubject>()
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
  shadowPublication: StoredPublication = {
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

  publicationForMode(mode: 'live' | 'shadow'): StoredPublication {
    return mode === 'live' ? this.publication : this.shadowPublication
  }
}

class RecordingClient {
  released = false
  readonly failures = new Map<string, Error>()

  constructor(readonly database: RecordingDatabase) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.database.calls.push({ sql: normalized, values })
    for (const [needle, error] of this.failures) {
      if (normalized.includes(needle)) throw error
    }

    if (normalized.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true } as unknown as Row], rowCount: 1 }

    if (normalized.startsWith('SELECT id, content_hash, deleted_at FROM subjects')) {
      const ids = new Set((values[0] as readonly string[]).map(Number))
      return {
        rows: [...this.database.subjects.entries()]
          .filter(([id]) => ids.has(id))
          .map(([id, subject]) => ({
            id,
            content_hash: subject.contentHash,
            deleted_at: subject.deletedAt,
          }) as unknown as Row),
        rowCount: this.database.subjects.size,
      }
    }

    if (normalized.startsWith('INSERT INTO subjects')) {
      this.database.subjects.set(Number(values[0]), {
        contentHash: String(values[3]),
        deletedAt: null,
      })
      return empty<Row>(1)
    }

    if (normalized.startsWith('SELECT user_id, subject_id, payload, content_hash')) {
      const userId = String(values[0])
      const rows: Row[] = []
      for (const [key, state] of this.database.collections) {
        const [storedUserId, storedSubjectId] = key.split(':')
        if (storedUserId !== userId) continue
        const data = this.database.collectionData.get(key)
        if (!data) continue
        rows.push({
          user_id: storedUserId,
          subject_id: Number(storedSubjectId),
          payload: data.payload,
          content_hash: data.contentHash,
          upstream_updated_at: data.upstreamUpdatedAt,
          observed_at: data.observedAt,
          missing_since: state.missingSince,
          deleted_at: state.deletedAt,
        } as unknown as Row)
      }
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('INSERT INTO collection_items')) {
      const key = `${String(values[0])}:${Number(values[1])}`
      this.database.collections.set(key, {
        deletedAt: null,
        missingRunId: null,
        missingSince: null,
      })
      this.database.collectionData.set(key, {
        payload: values[2] as Record<string, unknown>,
        contentHash: String(values[3]),
        upstreamUpdatedAt: values[4] === null ? null : String(values[4]),
        observedAt: String(values[5]),
      })
      return empty<Row>(1)
    }

    if (normalized.startsWith('UPDATE collection_items SET payload')) {
      const key = `${String(values[0])}:${Number(values[1])}`
      this.database.collections.set(key, { deletedAt: null, missingRunId: null, missingSince: null })
      this.database.collectionData.set(key, {
        payload: values[2] as Record<string, unknown>,
        contentHash: String(values[3]),
        upstreamUpdatedAt: values[4] === null ? null : String(values[4]),
        observedAt: String(values[5]),
      })
      return empty<Row>(1)
    }

    if (normalized.startsWith('UPDATE collection_items SET missing_since')) {
      const key = `${String(values[0])}:${Number(values[1])}`
      const state = this.database.collections.get(key)
      if (state && state.missingSince === null && state.deletedAt === null) {
        state.missingSince = String(values[2])
        state.missingRunId = String(values[3])
      }
      return empty<Row>(state ? 1 : 0)
    }

    if (normalized.startsWith('UPDATE collection_items SET deleted_at')) {
      const key = `${String(values[0])}:${Number(values[1])}`
      const state = this.database.collections.get(key)
      if (state && state.missingSince !== null && state.missingSince < String(values[2]) && state.deletedAt === null) {
        state.deletedAt = String(values[2])
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
      return { rows: [publicationRow(this.database.publicationForMode(publicationMode(values))) as unknown as Row], rowCount: 1 }
    }

    if (normalized === 'SELECT * FROM publications WHERE mode = $1') {
      return { rows: [publicationRow(this.database.publicationForMode(publicationMode(values))) as unknown as Row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE publications SET pending_generation')
      && !normalized.startsWith('UPDATE publications SET pending_generation = NULL')) {
      const publication = this.database.publicationForMode(publicationMode(values))
      Object.assign(publication, {
        pendingGeneration: Number(values[0]),
        pendingContentHash: String(values[1]),
        pendingObjectKey: String(values[2]),
        pendingRunId: String(values[3]),
        pendingClaimedAt: values[4] === null ? null : String(values[4]),
        pendingCreatedAt: String(values[5]),
      })
      return { rows: [publicationRow(publication) as unknown as Row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE publications SET pending_claimed_at')) {
      const publication = this.database.publicationForMode(publicationMode(values))
      const matches = publication.pendingGeneration === Number(values[0])
        && publication.pendingContentHash === String(values[1])
        && publication.pendingObjectKey === String(values[2])
        && publication.pendingRunId === String(values[3])
        && publication.pendingClaimedAt === null
        && publication.pendingGeneration === publication.verifiedGeneration + 1
      if (!matches) return empty<Row>()
      publication.pendingClaimedAt = String(values[4])
      return { rows: [publicationRow(publication) as unknown as Row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE publications SET pending_generation = NULL')) {
      const publication = this.database.publicationForMode(publicationMode(values))
      const verifiedHash = values[1] === null ? null : String(values[1])
      const matches = publication.verifiedGeneration === Number(values[0])
        && publication.verifiedContentHash === verifiedHash
        && publication.pendingGeneration !== null
        && publication.pendingClaimedAt === null
      if (!matches) return empty<Row>()
      Object.assign(publication, {
        pendingGeneration: null,
        pendingContentHash: null,
        pendingObjectKey: null,
        pendingRunId: null,
        pendingClaimedAt: null,
        pendingCreatedAt: null,
      })
      return { rows: [publicationRow(publication) as unknown as Row], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE publications SET verified_generation')) {
      const publication = this.database.publicationForMode(publicationMode(values))
      const matches = publication.pendingGeneration === Number(values[0])
        && publication.pendingContentHash === String(values[1])
        && publication.pendingObjectKey === String(values[2])
        && publication.pendingRunId === String(values[3])
        && publication.pendingClaimedAt !== null
        && publication.pendingClaimedAt === String(values[4])
        && publication.pendingGeneration === publication.verifiedGeneration + 1
      if (!matches) return empty<Row>()
      Object.assign(publication, {
        verifiedGeneration: Number(values[0]),
        verifiedContentHash: String(values[1]),
        verifiedObjectKey: String(values[2]),
        verifiedAt: String(values[5]),
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

function publicationMode(values: readonly unknown[]): 'live' | 'shadow' {
  return values.includes('shadow') ? 'shadow' : 'live'
}

const USER_ID = '10000000-0000-4000-8000-000000000001'
const RUN_1 = '20000000-0000-4000-8000-000000000001'
const RUN_2 = '20000000-0000-4000-8000-000000000002'
const RUN_3 = '20000000-0000-4000-8000-000000000003'

function asPool(pool: RecordingPool) {
  return pool as never
}

function authority(pool: RecordingPool, forbiddenValues: readonly string[] = ['fixture-secret']): PostgresAuthority {
  return new PostgresAuthority(asPool(pool), { forbiddenValues })
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
      subject: subject(subjectId),
    })),
  }
}

function subject(subjectId: number) {
  return {
    id: subjectId,
    subjectType: 2,
    payload: { id: subjectId, name: `subject-${subjectId}` },
    contentHash: `subject-hash-${subjectId}`,
    upstreamUpdatedAt: null,
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
    createdAt: '2026-08-28T04:00:00.000Z',
    ...overrides,
  }
}

test('rolls back the complete-state transaction and releases its client on a write failure', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const client = await pool.connect()
  client.failures.set('DELETE FROM calendar_entries', new Error('injected database failure'))
  pool.connect = async () => client

  await assert.rejects(
    () => repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])),
    /injected database failure/,
  )

  const statements = pool.database.calls.map((call) => call.sql)
  assert.equal(statements[0], 'BEGIN')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
  assert.equal(client.released, true)
})

test('releases the transaction client when BEGIN fails', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const client = await pool.connect()
  client.failures.set('BEGIN', new Error('begin failed'))
  pool.connect = async () => client

  await assert.rejects(
    () => repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [])),
    /begin failed/,
  )
  assert.equal(client.released, true)
  assert.equal(pool.database.calls.some((call) => call.sql === 'ROLLBACK'), false)
})

test('preserves the primary transaction error when ROLLBACK also fails', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const client = await pool.connect()
  client.failures.set('DELETE FROM calendar_entries', new Error('work failed'))
  client.failures.set('ROLLBACK', new Error('rollback failed'))
  pool.connect = async () => client

  await assert.rejects(
    () => repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [])),
    /work failed/,
  )
  assert.equal(client.released, true)
})

test('rolls back and releases the transaction client when COMMIT fails', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const client = await pool.connect()
  client.failures.set('COMMIT', new Error('commit failed'))
  pool.connect = async () => client

  await assert.rejects(
    () => repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [])),
    /commit failed/,
  )
  assert.equal(pool.database.calls.some((call) => call.sql === 'ROLLBACK'), true)
  assert.equal(client.released, true)
})

test('upserts the normalized subject for a calendar-only entry before inserting its foreign key', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const input: CompleteStateInput = {
    ...completeState(RUN_1, '2026-08-28T01:00:00.000Z', []),
    calendarEntries: [{
      weekdayId: 2,
      subjectId: 99,
      subject: subject(99),
      payload: { weekday: { id: 2 }, subject_id: 99 },
    }],
  }

  await repository.commitCompleteState(input)

  const subjectWrite = pool.database.calls.findIndex((call) => (
    call.sql.startsWith('INSERT INTO subjects') && call.values[0] === 99
  ))
  const calendarWrite = pool.database.calls.findIndex((call) => call.sql.startsWith('INSERT INTO calendar_entries'))
  assert.ok(subjectWrite >= 0)
  assert.ok(calendarWrite > subjectWrite)
})

test('uses observation time rather than run identity to confirm a missing collection', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)

  await repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1]))
  await repository.commitCompleteState(completeState(RUN_2, '2026-08-28T02:00:00.000Z', []))
  await repository.commitCompleteState(completeState(RUN_2, '2026-08-28T03:00:00.000Z', []))

  assert.equal(pool.database.collections.get(`${USER_ID}:1`)?.deletedAt, '2026-08-28T03:00:00.000Z')
})

test('does not confirm deletion for a different run at the same or older observation time', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)

  await repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1]))
  await repository.commitCompleteState(completeState(RUN_2, '2026-08-28T02:00:00.000Z', []))
  await repository.commitCompleteState(completeState(RUN_3, '2026-08-28T02:00:00.000Z', []))
  assert.equal(pool.database.collections.get(`${USER_ID}:1`)?.deletedAt, null)

  await repository.commitCompleteState(completeState(RUN_3, '2026-08-28T00:30:00.000Z', []))
  assert.equal(pool.database.collections.get(`${USER_ID}:1`)?.deletedAt, null)
})

test('performs zero subject or collection writes for an unchanged complete observation', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)

  await repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1]))
  const writesBefore = pool.database.calls.filter(isSubjectOrCollectionWrite).length
  await repository.commitCompleteState(completeState(RUN_2, '2026-08-28T02:00:00.000Z', [1]))

  assert.equal(pool.database.calls.filter(isSubjectOrCollectionWrite).length, writesBefore)
})

test('confirms deletion only on a second distinct complete observation and restoration clears missing state', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)

  await repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1]))
  await repository.commitCompleteState(completeState(RUN_2, '2026-08-28T02:00:00.000Z', []))
  assert.deepEqual(pool.database.collections.get(`${USER_ID}:1`), {
    deletedAt: null,
    missingRunId: RUN_2,
    missingSince: '2026-08-28T02:00:00.000Z',
  })

  await repository.commitCompleteState(completeState(RUN_3, '2026-08-28T03:00:00.000Z', []))
  assert.equal(pool.database.collections.get(`${USER_ID}:1`)?.deletedAt, '2026-08-28T03:00:00.000Z')

  await repository.commitCompleteState(completeState(RUN_3, '2026-08-28T04:00:00.000Z', [1]))
  assert.deepEqual(pool.database.collections.get(`${USER_ID}:1`), {
    deletedAt: null,
    missingRunId: null,
    missingSince: null,
  })
})

test('rejects an older media result without replacing last-known-good state', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)

  assert.equal(await repository.applyMediaResult(mediaResult()), true)
  assert.equal(await repository.applyMediaResult(mediaResult({
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
  const repository = authority(pool)

  const candidates = await repository.listDueMedia({
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
  const repository = authority(pool)
  const first = pending()

  assert.equal((await repository.savePendingPublication(first)).pendingContentHash, first.contentHash)
  const writesAfterFirst = pool.database.calls.filter((call) => call.sql.startsWith('UPDATE publications SET pending_generation')).length
  assert.equal((await repository.savePendingPublication(first)).pendingContentHash, first.contentHash)
  assert.equal(
    pool.database.calls.filter((call) => call.sql.startsWith('UPDATE publications SET pending_generation')).length,
    writesAfterFirst,
  )

  const replacement = pending({ contentHash: 'b'.repeat(64), objectKey: `public/snapshots/1-${'b'.repeat(64)}.json`, runId: RUN_2 })
  assert.equal((await repository.savePendingPublication(replacement)).pendingContentHash, replacement.contentHash)

  pool.database.publication.pendingClaimedAt = '2026-08-28T04:10:00.000Z'
  await assert.rejects(
    () => repository.savePendingPublication(pending({ contentHash: 'c'.repeat(64), objectKey: `public/snapshots/1-${'c'.repeat(64)}.json` })),
    /PUBLICATION_GENERATION_CONFLICT/,
  )
  await assert.rejects(
    () => repository.savePendingPublication(pending({ generation: 2 })),
    /PUBLICATION_GENERATION_CONFLICT/,
  )
})

test('does not treat a different pending run identity as an exact no-op replay', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const first = pending()
  await repository.savePendingPublication(first)
  const writesBefore = pool.database.calls.filter((call) => call.sql.startsWith('UPDATE publications SET pending_generation')).length

  const resumed = await repository.savePendingPublication(pending({
    runId: RUN_2,
    createdAt: '2026-08-28T04:05:00.000Z',
  }))

  assert.equal(resumed.pendingRunId, RUN_2)
  assert.equal(
    pool.database.calls.filter((call) => call.sql.startsWith('UPDATE publications SET pending_generation')).length,
    writesBefore + 1,
  )
})

test('claims an exact unclaimed pending publication with a conditional state transition', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const candidate = pending()
  await repository.savePendingPublication(candidate)

  const claimed = await repository.claimPendingPublication({
    generation: candidate.generation,
    contentHash: candidate.contentHash,
    objectKey: candidate.objectKey,
    runId: candidate.runId,
    claimedAt: '2026-08-28T04:10:00.000Z',
  })

  assert.equal(claimed.pendingClaimedAt, '2026-08-28T04:10:00.000Z')
})

test('clears only an unclaimed pending publication for an unchanged verified generation', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  pool.database.publication.verifiedGeneration = 1
  pool.database.publication.verifiedContentHash = 'v'.repeat(64)
  await repository.savePendingPublication(pending({ generation: 2 }))

  const cleared = await repository.clearUnclaimedPending({
    verifiedGeneration: 1,
    verifiedContentHash: 'v'.repeat(64),
  })
  assert.equal(cleared.pendingGeneration, null)
  const cleanup = pool.database.calls.find((call) => call.sql.startsWith('UPDATE publications SET pending_generation = NULL'))
  assert.ok(cleanup?.sql.includes('WHERE mode = $3'))
  assert.deepEqual(cleanup?.values, [1, 'v'.repeat(64), 'live'])

  await repository.savePendingPublication(pending({ generation: 2 }))
  await repository.claimPendingPublication({
    generation: 2,
    contentHash: 'a'.repeat(64),
    objectKey: `public/snapshots/1-${'a'.repeat(64)}.json`,
    runId: RUN_1,
    claimedAt: '2026-08-28T04:10:00.000Z',
  })
  const preserved = await repository.clearUnclaimedPending({
    verifiedGeneration: 1,
    verifiedContentHash: 'v'.repeat(64),
  })
  assert.equal(preserved.pendingGeneration, 2)
})

test('rejects a stale no-change cleanup caller after verified publication advances', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  pool.database.publication.verifiedGeneration = 2
  pool.database.publication.verifiedContentHash = 'n'.repeat(64)

  await assert.rejects(
    () => repository.clearUnclaimedPending({
      verifiedGeneration: 1,
      verifiedContentHash: 'o'.repeat(64),
    }),
    /PUBLICATION_GENERATION_CONFLICT/,
  )
})

test('verifies only an exact claimed pending owner and safely replays that claim', async () => {
  const unclaimedPool = new RecordingPool()
  const unclaimedRepository = authority(unclaimedPool)
  const candidate = pending()
  const claimedAt = '2026-08-28T04:10:00.000Z'
  await unclaimedRepository.savePendingPublication(candidate)

  await assert.rejects(
    () => unclaimedRepository.verifyPublication({
      generation: candidate.generation,
      contentHash: candidate.contentHash,
      objectKey: candidate.objectKey,
      runId: candidate.runId,
      claimedAt,
      verifiedAt: '2026-08-28T05:00:00.000Z',
    }),
    /PUBLICATION_GENERATION_CONFLICT/,
  )

  const pool = new RecordingPool()
  const repository = authority(pool)
  await repository.savePendingPublication(candidate)
  const claim = {
    generation: candidate.generation,
    contentHash: candidate.contentHash,
    objectKey: candidate.objectKey,
    runId: candidate.runId,
    claimedAt,
  }
  await repository.claimPendingPublication(claim)
  assert.equal((await repository.claimPendingPublication(claim)).pendingClaimedAt, claimedAt)

  await assert.rejects(
    () => repository.verifyPublication({
      ...claim,
      runId: RUN_2,
      verifiedAt: '2026-08-28T05:00:00.000Z',
    }),
    /PUBLICATION_GENERATION_CONFLICT/,
  )
  await assert.rejects(
    () => repository.verifyPublication({
      ...claim,
      claimedAt: '2026-08-28T04:11:00.000Z',
      verifiedAt: '2026-08-28T05:00:00.000Z',
    }),
    /PUBLICATION_GENERATION_CONFLICT/,
  )

  const state = await repository.verifyPublication({
    ...claim,
    verifiedAt: '2026-08-28T05:00:00.000Z',
  })
  assert.equal(state.verifiedGeneration, 1)
  assert.equal(state.pendingGeneration, null)
  assert.deepEqual(await repository.getPublicationState(), state)

  await assert.rejects(
    () => repository.verifyPublication({
      generation: 2,
      contentHash: 'd'.repeat(64),
      objectKey: `public/snapshots/2-${'d'.repeat(64)}.json`,
      runId: RUN_2,
      claimedAt: '2026-08-28T05:10:00.000Z',
      verifiedAt: '2026-08-28T06:00:00.000Z',
    }),
    /PUBLICATION_GENERATION_CONFLICT/,
  )
})

test('persists only the sanitized run error projection and parameterizes every business value', async () => {
  const secret = 'repository-test-secret-do-not-store'
  const pool = new RecordingPool()
  const repository = authority(pool, [secret])

  await repository.beginRun({
    id: RUN_1,
    source: 'scheduled',
    mode: 'shadow',
    stage: 'collection',
    status: 'running',
    startedAt: '2026-08-28T01:00:00.000Z',
    heartbeatAt: '2026-08-28T01:00:00.000Z',
    gitSha: 'a'.repeat(40),
  })
  await repository.finishRun({
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
    },
    components: { publication: 'not_attempted' },
  })

  const serializedCalls = JSON.stringify(pool.database.calls)
  assert.equal(serializedCalls.includes(secret), false)
  for (const call of pool.database.calls.filter((entry) => entry.values.length > 0)) {
    assert.match(call.sql, /\$\d/)
    assert.equal(call.sql.includes(RUN_1), false)
  }
})

test('rejects an opaque begin-run stage before issuing any query', async () => {
  const pool = new RecordingPool()

  await assert.rejects(
    () => authority(pool).beginRun({
      id: RUN_1,
      source: 'scheduled',
      mode: 'shadow',
      stage: { opaque: 'unsafe' },
      status: 'running',
      startedAt: '2026-08-28T01:00:00.000Z',
      heartbeatAt: '2026-08-28T01:00:00.000Z',
      gitSha: 'a'.repeat(40),
    } as never),
    /FORBIDDEN_PERSISTENCE_SHAPE/,
  )
  assert.equal(pool.database.calls.length, 0)
})

test('rejects opaque finish-run stage and status before issuing any query', async () => {
  const invalidRunFields = [
    { stage: { opaque: 'unsafe' } },
    { status: { opaque: 'unsafe' } },
  ]

  for (const invalidFields of invalidRunFields) {
    const pool = new RecordingPool()
    await assert.rejects(
      () => authority(pool).finishRun({
        id: RUN_1,
        stage: 'finished',
        status: 'failed',
        heartbeatAt: '2026-08-28T02:00:00.000Z',
        finishedAt: '2026-08-28T02:00:00.000Z',
        counts: { users: 1 },
        stageDurations: { collection: 100 },
        sanitizedError: null,
        components: { publication: 'failed' },
        ...invalidFields,
      } as never),
      /FORBIDDEN_PERSISTENCE_SHAPE/,
    )
    assert.equal(pool.database.calls.length, 0)
  }
})

test('rejects opaque publication text fields before issuing any query', async () => {
  const calls = [
    (repository: PostgresAuthority) => repository.savePendingPublication({
      ...pending(),
      objectKey: { opaque: 'unsafe' },
    } as never),
    (repository: PostgresAuthority) => repository.claimPendingPublication({
      generation: 1,
      contentHash: { opaque: 'unsafe' },
      objectKey: `public/snapshots/1-${'a'.repeat(64)}.json`,
      runId: RUN_1,
      claimedAt: '2026-08-28T04:10:00.000Z',
    } as never),
    (repository: PostgresAuthority) => repository.clearUnclaimedPending({
      verifiedGeneration: 0,
      verifiedContentHash: { opaque: 'unsafe' },
    } as never),
    (repository: PostgresAuthority) => repository.verifyPublication({
      generation: 1,
      contentHash: 'a'.repeat(64),
      objectKey: { opaque: 'unsafe' },
      runId: RUN_1,
      claimedAt: '2026-08-28T04:10:00.000Z',
      verifiedAt: '2026-08-28T05:00:00.000Z',
    } as never),
  ]

  for (const call of calls) {
    const pool = new RecordingPool()
    await assert.rejects(() => call(authority(pool)), /FORBIDDEN_PERSISTENCE_SHAPE/)
    assert.equal(pool.database.calls.length, 0)
  }
})

test('requires a non-empty persistence secret guard at construction', () => {
  const pool = new RecordingPool()
  assert.throws(
    () => new PostgresAuthority(asPool(pool), { forbiddenValues: [] }),
    /PERSISTENCE_SECRETS_REQUIRED/,
  )
})

test('rejects raw response shapes across normalized state, media, and run DTOs', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const state = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(state.users[0]?.items[0]?.subject.payload as Record<string, unknown>).rawResponse = { body: 'unsafe' }

  await assert.rejects(
    () => repository.commitCompleteState(state),
    /FORBIDDEN_PERSISTENCE_SHAPE/,
  )
  await assert.rejects(
    () => repository.applyMediaResult(mediaResult({
      status: { detail: 'success', rawResponse: 'unsafe' } as never,
    })),
    /FORBIDDEN_PERSISTENCE_SHAPE/,
  )
  await assert.rejects(
    () => repository.finishRun({
      id: RUN_1,
      stage: 'finished',
      status: 'failed',
      heartbeatAt: '2026-08-28T02:00:00.000Z',
      finishedAt: '2026-08-28T02:00:00.000Z',
      counts: { users: 1, rawResponse: { body: 'unsafe' } },
      stageDurations: { collection: 100 },
      sanitizedError: null,
      components: { publication: 'not_attempted' },
    } as never),
    /FORBIDDEN_PERSISTENCE_SHAPE/,
  )
})

test('rejects opaque nested values and inexact shapes across complete-state JSON DTOs', async () => {
  const invalidStates: CompleteStateInput[] = []

  const images = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(images.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).images = {
    common: null,
    large: null,
    opaque: { body: 'unsafe' },
  }
  invalidStates.push(images)

  const rating = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(rating.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).rating = {
    score: { opaque: 'unsafe' },
    rank: 1,
    total: 1,
  }
  invalidStates.push(rating)

  const tags = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(tags.users[0]!.items[0]!.collection.payload as unknown as Record<string, unknown>).tags = [
    'safe',
    { opaque: 'unsafe' },
  ]
  invalidStates.push(tags)

  const weekday = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(weekday.calendarEntries[0]!.payload.weekday as unknown as Record<string, unknown>).en = {
    opaque: 'unsafe',
  }
  invalidStates.push(weekday)

  for (const input of invalidStates) {
    const pool = new RecordingPool()
    await assert.rejects(
      () => authority(pool).commitCompleteState(input),
      /FORBIDDEN_PERSISTENCE_SHAPE/,
    )
    assert.equal(pool.database.calls.length, 0)
  }
})

test('rejects opaque nested values and invalid scalars across media JSON DTOs', async () => {
  const invalidMedia: MediaResultInput[] = [
    mediaResult({ detail: { name: { opaque: 'unsafe' } } as never }),
    mediaResult({
      metadata: {
        exists: true,
        nsfw: false,
        checked_at: Number.POSITIVE_INFINITY,
        reason: 'subject_detail',
      },
    }),
    mediaResult({
      imageRefs: {
        common: { hash: 'hash', uri: 'uri', r2_key: 'key', opaque: { body: 'unsafe' } },
        large: null,
      } as never,
    }),
    mediaResult({ status: { detail: { opaque: 'unsafe' } } as never }),
  ]

  for (const input of invalidMedia) {
    const pool = new RecordingPool()
    await assert.rejects(
      () => authority(pool).applyMediaResult(input),
      /FORBIDDEN_PERSISTENCE_SHAPE/,
    )
    assert.equal(pool.database.calls.length, 0)
  }
})

test('rejects opaque nested values and invalid scalars across run JSON DTOs', async () => {
  const invalidProjections = [
    { counts: { users: { opaque: 'unsafe' } } },
    { stageDurations: { collection: Number.NaN } },
    { components: { publication: { opaque: 'unsafe' } } },
    { sanitizedError: { category: { opaque: 'unsafe' }, code: 'E', attemptCount: 1, stage: 'collection' } },
    {
      sanitizedError: {
        category: 'upstream',
        code: 'E',
        attemptCount: 1,
        stage: 'collection',
        opaque: { body: 'unsafe' },
      },
    },
  ]

  for (const projection of invalidProjections) {
    const pool = new RecordingPool()
    await assert.rejects(
      () => authority(pool).finishRun({
        id: RUN_1,
        stage: 'finished',
        status: 'failed',
        heartbeatAt: '2026-08-28T02:00:00.000Z',
        finishedAt: '2026-08-28T02:00:00.000Z',
        counts: { users: 1 },
        stageDurations: { collection: 100 },
        sanitizedError: null,
        components: { publication: 'failed' },
        ...projection,
      } as never),
      /FORBIDDEN_PERSISTENCE_SHAPE/,
    )
    assert.equal(pool.database.calls.length, 0)
  }
})

test('rejects explicit own-property undefined across optional complete-state fields before issuing any query', async () => {
  const invalidStates: CompleteStateInput[] = []

  const explicitNameUndefined = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(explicitNameUndefined.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).name = undefined
  invalidStates.push(explicitNameUndefined)

  const explicitRatingUndefined = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(explicitRatingUndefined.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).rating = undefined
  invalidStates.push(explicitRatingUndefined)

  const explicitRatingScoreUndefined = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(explicitRatingScoreUndefined.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).rating = {
    score: undefined,
    rank: 1,
  }
  invalidStates.push(explicitRatingScoreUndefined)

  const explicitRatingRankUndefined = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(explicitRatingRankUndefined.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).rating = {
    rank: undefined,
    total: 1,
  }
  invalidStates.push(explicitRatingRankUndefined)

  const explicitRatingTotalUndefined = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(explicitRatingTotalUndefined.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).rating = {
    total: undefined,
  }
  invalidStates.push(explicitRatingTotalUndefined)

  const explicitImagesUndefined = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(explicitImagesUndefined.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).images = undefined
  invalidStates.push(explicitImagesUndefined)

  const explicitImageFieldUndefined = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(explicitImageFieldUndefined.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).images = {
    common: undefined,
    large: null,
  }
  invalidStates.push(explicitImageFieldUndefined)

  for (const input of invalidStates) {
    const pool = new RecordingPool()
    await assert.rejects(
      () => authority(pool).commitCompleteState(input),
      /FORBIDDEN_PERSISTENCE_SHAPE/,
    )
    assert.equal(pool.database.calls.length, 0)
  }
})

test('keeps valid optional-field presence and absence accepted', async () => {
  const validStates: CompleteStateInput[] = []

  const missingOptionals = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(missingOptionals.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).name = ''
  ;(missingOptionals.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).type = 0
  ;(missingOptionals.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).rating = { score: 0 }
  ;(missingOptionals.users[0]!.items[0]!.subject.payload as unknown as Record<string, unknown>).images = {
    common: null,
  }
  validStates.push(missingOptionals)

  for (const input of validStates) {
    const pool = new RecordingPool()
    await authority(pool).commitCompleteState(input)
    assert.ok(pool.database.calls.length > 0)
  }
})

test('rejects explicit own-property undefined collection tags and media expires_at before issuing any query', async () => {
  const tagsUndefined = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(tagsUndefined.users[0]!.items[0]!.collection.payload as unknown as Record<string, unknown>).tags = undefined

  const mediaUndefined = mediaResult({
    metadata: {
      exists: true,
      nsfw: false,
      checked_at: 1,
      expires_at: undefined,
      reason: 'subject_detail',
    } as never,
  })

  {
    const pool = new RecordingPool()
    await assert.rejects(
      () => authority(pool).commitCompleteState(tagsUndefined),
      /FORBIDDEN_PERSISTENCE_SHAPE/,
    )
    assert.equal(pool.database.calls.length, 0)
  }

  {
    const pool = new RecordingPool()
    await assert.rejects(
      () => authority(pool).applyMediaResult(mediaUndefined),
      /FORBIDDEN_PERSISTENCE_SHAPE/,
    )
    assert.equal(pool.database.calls.length, 0)
  }
})

test('keeps valid collection tags and media expires_at accepted', async () => {
  const tagsAbsent = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  const tagsStrings = completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1])
  ;(tagsStrings.users[0]!.items[0]!.collection.payload as unknown as Record<string, unknown>).tags = ['safe']

  for (const input of [tagsAbsent, tagsStrings]) {
    const pool = new RecordingPool()
    await authority(pool).commitCompleteState(input)
    assert.ok(pool.database.calls.length > 0)
  }

  const mediaFinite = mediaResult({
    metadata: {
      exists: true,
      nsfw: false,
      checked_at: 1,
      expires_at: 1234567890,
      reason: 'subject_detail',
    } as never,
  })
  const mediaNullExpires = mediaResult({
    metadata: {
      exists: true,
      nsfw: false,
      checked_at: 1,
      expires_at: null,
      reason: 'subject_detail',
    } as never,
  })
  const mediaAbsentExpires = mediaResult({
    metadata: {
      exists: true,
      nsfw: false,
      checked_at: 1,
      reason: 'subject_detail',
    } as never,
  })

  for (const input of [mediaFinite, mediaNullExpires, mediaAbsentExpires]) {
    const pool = new RecordingPool()
    await authority(pool).applyMediaResult(input)
    assert.ok(pool.database.calls.length > 0)
  }
})

test('adds run fences forward-only after the immutable initial schema', async () => {
  const initial = await readFile(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8')
  const constraints = await readFile(new URL('./migrations/0002_authority_constraints.sql', import.meta.url), 'utf8')

  assert.ok(initial.indexOf('CREATE TABLE sync_runs') > initial.indexOf('CREATE TABLE collection_items'))
  assert.doesNotMatch(initial, /missing_run_id|observed_run_id/)
  assert.match(constraints, /missing_run_id uuid REFERENCES sync_runs\(id\)/)
  assert.match(constraints, /CHECK \(\(missing_since IS NULL\) = \(missing_run_id IS NULL\)\)/)
  assert.match(constraints, /observed_run_id uuid REFERENCES sync_runs\(id\)/)
  assert.match(constraints, /CHECK \(\(observed_at IS NULL\) = \(observed_run_id IS NULL\)\)/)
})

test('keeps the real database JSON/text probes and proves the column scan completes', async () => {
  const integrationSource = await readFile(new URL('./postgres.integration.test.ts', import.meta.url), 'utf8')

  assert.match(integrationSource, /stage: \{ opaque: MARKER \}/)
  assert.match(integrationSource, /SELECT count\(\*\) AS count FROM sync_runs WHERE id = \$1/)
  assert.match(integrationSource, /const SECRET_PROBE_SUBJECT_ID = 9_999_991/)
  assert.match(integrationSource, /subject\(SECRET_PROBE_SUBJECT_ID\).*name: MARKER/s)
  assert.match(integrationSource, /state\([^\n]+\[SECRET_PROBE_SUBJECT_ID\], \[\]\)/)
  assert.match(integrationSource, /assert\.equal\(scannedColumns, columns\.rows\.length\)/)
})

function isSubjectOrCollectionWrite(call: QueryCall): boolean {
  return call.sql.startsWith('INSERT INTO subjects')
    || call.sql.startsWith('UPDATE subjects')
    || call.sql.startsWith('INSERT INTO collection_items')
    || call.sql.startsWith('UPDATE collection_items')
}

test('complete-state returns committed diff counts including a subsequent unchanged observation', async () => {
  const pool = new RecordingPool()
  const repository = authority(pool)
  const first = await repository.commitCompleteState(completeState(RUN_1, '2026-08-28T01:00:00.000Z', [1]))
  assert.equal(first.inserted, 1)
  const next = await repository.commitCompleteState(completeState(RUN_1, '2026-08-29T01:00:00.000Z', [1]))
  assert.equal(next.inserted, 0)
  assert.equal(next.unchanged, 1)
})
