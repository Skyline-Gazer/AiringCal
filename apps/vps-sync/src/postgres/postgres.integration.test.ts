import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { applyMigrations, assertCurrentSchema, withSessionLock } from './migrate.ts'
import {
  PostgresAuthority,
  type CompleteStateInput,
  type PendingPublicationInput,
  type SubjectInput,
} from './repositories.ts'

const MARKER = 'postgres-integration-secret-marker'

test('PostgreSQL integration exercises the real authority boundary', async (t) => {
  const databaseUrl = process.env.DATABASE_URL
  assert.ok(databaseUrl, 'DATABASE_URL_REQUIRED_FOR_POSTGRES_INTEGRATION')

  const schema = `vps_sync_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  let database: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    database = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 8,
    })

    await t.test('upgrades the immutable 0001 migration to the current schema', async () => {
      await assert.rejects(() => assertCurrentSchema(database!), /MIGRATION_SCHEMA_BEHIND/)

      const initialSql = await readFile(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8')
      const initialChecksum = createHash('sha256').update(initialSql).digest('hex')
      assert.equal(initialChecksum, 'cd06c6a655aee9762095de384407e584a2340ad9b7a5a17b027adb966337486f')
      await database!.query(`
        CREATE TABLE schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `)
      await database!.query(initialSql)
      await database!.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        ['0001_initial.sql', initialChecksum],
      )

      const concurrent = await Promise.allSettled([
        applyMigrations(database!),
        applyMigrations(database!),
      ])
      assert.ok(concurrent.some((result) => result.status === 'fulfilled'))
      for (const result of concurrent) {
        if (result.status === 'rejected') assert.match(String(result.reason), /MIGRATION_LOCK_UNAVAILABLE/)
      }
      await assertCurrentSchema(database!)
      const applied = await database!.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      )
      assert.deepEqual(applied.rows.map((row) => row.name), [
        '0001_initial.sql',
        '0002_authority_constraints.sql',
      ])

      await database!.query(
        'UPDATE schema_migrations SET checksum = $2 WHERE name = $1',
        ['0001_initial.sql', 'f'.repeat(64)],
      )
      await assert.rejects(() => applyMigrations(database!), /MIGRATION_CHECKSUM_MISMATCH/)
      await database!.query(
        'UPDATE schema_migrations SET checksum = $2 WHERE name = $1',
        ['0001_initial.sql', initialChecksum],
      )
    })

    await t.test('enforces a PostgreSQL session advisory lock across connections', async () => {
      const firstClient = await database!.connect()
      const secondClient = await database!.connect()
      let finishFirst!: () => void
      let markFirstEntered!: () => void
      const holdFirst = new Promise<void>((resolve) => { finishFirst = resolve })
      const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve })
      try {
        const first = withSessionLock(firstClient, 4_200_001n, async () => {
          markFirstEntered()
          await holdFirst
          return 'first'
        })
        await firstEntered
        const second = await withSessionLock(secondClient, 4_200_001n, async () => 'second')
        finishFirst()
        const firstResult = await first
        assert.equal(firstResult.acquired, true)
        assert.equal(second.acquired, false)
      } finally {
        finishFirst?.()
        firstClient.release()
        secondClient.release()
      }
    })

    const authority = new PostgresAuthority(database, { forbiddenValues: [MARKER] })

    await t.test('commits calendar-only subjects and rolls back a failed complete state', async () => {
      const calendarRun = runId(1)
      await beginRun(authority, calendarRun, '2026-08-29T00:00:00.000Z')
      await authority.commitCompleteState(state(calendarRun, '2026-08-29T00:00:00.000Z', [], [99]))
      assert.equal(
        Number((await database!.query('SELECT count(*) AS count FROM subjects WHERE id = 99')).rows[0]?.count),
        1,
      )

      const rollbackRun = runId(2)
      await beginRun(authority, rollbackRun, '2026-08-29T01:00:00.000Z')
      const invalid = state(rollbackRun, '2026-08-29T01:00:00.000Z', [101], [101])
      invalid.calendarEntries = [invalid.calendarEntries[0]!, invalid.calendarEntries[0]!]
      await assert.rejects(() => authority.commitCompleteState(invalid))
      assert.equal(
        Number((await database!.query('SELECT count(*) AS count FROM subjects WHERE id = 101')).rows[0]?.count),
        0,
      )
      assert.equal(
        Number((await database!.query('SELECT count(*) AS count FROM collection_items WHERE subject_id = 101')).rows[0]?.count),
        0,
      )
    })

    await t.test('uses canonical observation time semantics and emits zero unchanged writes', async () => {
      const firstRun = runId(3)
      await beginRun(authority, firstRun, '2026-08-29T02:00:00.000Z')
      await authority.commitCompleteState(state(firstRun, '2026-08-29T02:00:00.000Z', [1], [1]))
      const before = await rowVersions(database!, 1)

      const unchangedRun = runId(4)
      await beginRun(authority, unchangedRun, '2026-08-29T03:00:00.000Z')
      await authority.commitCompleteState(state(unchangedRun, '2026-08-29T03:00:00.000Z', [1], [1]))
      assert.deepEqual(await rowVersions(database!, 1), before)

      const missingRun = runId(5)
      await beginRun(authority, missingRun, '2026-08-29T04:00:00.000Z')
      await authority.commitCompleteState(state(missingRun, '2026-08-29T04:00:00.000Z', [], []))

      const sameTimeRun = runId(6)
      await beginRun(authority, sameTimeRun, '2026-08-29T04:00:00.000Z')
      await authority.commitCompleteState(state(sameTimeRun, '2026-08-29T04:00:00.000Z', [], []))
      assert.equal(await collectionDeletedAt(database!, 1), null)

      await authority.commitCompleteState(state(missingRun, '2026-08-29T05:00:00.000Z', [], []))
      assert.equal(await collectionDeletedAt(database!, 1), '2026-08-29T05:00:00.000Z')

      const restoredRun = runId(7)
      await beginRun(authority, restoredRun, '2026-08-29T06:00:00.000Z')
      await authority.commitCompleteState(state(restoredRun, '2026-08-29T06:00:00.000Z', [1], [1]))
      const restored = await database!.query<{ missing_since: Date | null; deleted_at: Date | null }>(
        'SELECT missing_since, deleted_at FROM collection_items WHERE subject_id = $1',
        [1],
      )
      assert.equal(restored.rows[0]?.missing_since, null)
      assert.equal(restored.rows[0]?.deleted_at, null)
    })

    await t.test('rejects stale media and enforces publication claim/cleanup CAS', async () => {
      assert.equal(await authority.applyMediaResult({
        subjectId: 1,
        detail: { name: 'fresh' },
        metadata: null,
        imageRefs: null,
        detailHash: 'fresh-hash',
        metadataHash: null,
        imageHash: null,
        status: { detail: 'success' },
        observedAt: '2026-08-29T07:00:00.000Z',
        runId: runId(7),
        nextRetryAt: null,
        deletedAt: null,
        lastSuccessAt: '2026-08-29T07:00:00.000Z',
      }), true)
      assert.equal(await authority.applyMediaResult({
        subjectId: 1,
        detail: { name: 'stale' },
        metadata: null,
        imageRefs: null,
        detailHash: 'stale-hash',
        metadataHash: null,
        imageHash: null,
        status: { detail: 'success' },
        observedAt: '2026-08-29T06:00:00.000Z',
        runId: runId(6),
        nextRetryAt: null,
        deletedAt: null,
        lastSuccessAt: '2026-08-29T06:00:00.000Z',
      }), false)
      const media = await database!.query<{ detail: { name: string } }>(
        'SELECT detail FROM subject_media WHERE subject_id = $1',
        [1],
      )
      assert.equal(media.rows[0]?.detail.name, 'fresh')

      const candidate = pending(runId(7), 1, 'a')
      await authority.savePendingPublication(candidate)
      const claim = {
        generation: 1,
        contentHash: candidate.contentHash,
        objectKey: candidate.objectKey,
        runId: candidate.runId,
        claimedAt: '2026-08-29T07:30:00.000Z',
      }
      await assert.rejects(
        () => authority.verifyPublication({
          ...claim,
          verifiedAt: '2026-08-29T08:00:00.000Z',
        }),
        /PUBLICATION_GENERATION_CONFLICT/,
      )
      const claimed = await authority.claimPendingPublication(claim)
      assert.equal((await authority.claimPendingPublication(claim)).pendingClaimedAt, claim.claimedAt)
      await assert.rejects(
        () => authority.verifyPublication({
          ...claim,
          runId: runId(6),
          verifiedAt: '2026-08-29T08:00:00.000Z',
        }),
        /PUBLICATION_GENERATION_CONFLICT/,
      )
      await assert.rejects(
        () => authority.verifyPublication({
          ...claim,
          claimedAt: '2026-08-29T07:31:00.000Z',
          verifiedAt: '2026-08-29T08:00:00.000Z',
        }),
        /PUBLICATION_GENERATION_CONFLICT/,
      )
      assert.equal(claimed.pendingClaimedAt, '2026-08-29T07:30:00.000Z')
      await assert.rejects(
        () => authority.savePendingPublication(pending(runId(6), 1, 'b')),
        /PUBLICATION_GENERATION_CONFLICT/,
      )
      assert.equal((await authority.clearUnclaimedPending({
        verifiedGeneration: 0,
        verifiedContentHash: null,
      })).pendingGeneration, 1)
      await authority.verifyPublication({
        ...claim,
        verifiedAt: '2026-08-29T08:00:00.000Z',
      })

      await authority.savePendingPublication(pending(runId(7), 2, 'c'))
      assert.equal((await authority.clearUnclaimedPending({
        verifiedGeneration: 1,
        verifiedContentHash: candidate.contentHash,
      })).pendingGeneration, null)
      await assert.rejects(
        () => authority.clearUnclaimedPending({ verifiedGeneration: 0, verifiedContentHash: null }),
        /PUBLICATION_GENERATION_CONFLICT/,
      )
    })

    await t.test('rejects markers at every JSON/text boundary and scans every stored text/json column', async () => {
      await assert.rejects(() => authority.commitCompleteState({
        ...state(runId(7), '2026-08-29T09:00:00.000Z', [1], [1]),
        users: [{
          id: userId(),
          upstreamUserId: '42',
          items: [{
            subject: { ...subject(1), payload: { id: 1, name: MARKER } },
            collection: collection(1),
          }],
        }],
      }))
      await assert.rejects(() => authority.applyMediaResult({
        subjectId: 1,
        detail: { name: MARKER },
        metadata: null,
        imageRefs: null,
        detailHash: 'marker-hash',
        metadataHash: null,
        imageHash: null,
        status: { detail: 'success' },
        observedAt: '2026-08-29T09:00:00.000Z',
        runId: runId(7),
        nextRetryAt: null,
        deletedAt: null,
        lastSuccessAt: null,
      }))
      await assert.rejects(() => authority.finishRun({
        id: runId(7),
        stage: 'finished',
        status: 'failed',
        heartbeatAt: '2026-08-29T09:00:00.000Z',
        finishedAt: '2026-08-29T09:00:00.000Z',
        counts: { users: 1, rawResponse: MARKER },
        stageDurations: { collection: 1 },
        sanitizedError: null,
        components: { publication: 'failed' },
      } as never))
      await assert.rejects(() => authority.savePendingPublication({
        ...pending(runId(7), 2, 'd'),
        objectKey: `snapshots/${MARKER}`,
      }))

      const columns = await database!.query<{ table_name: string; column_name: string }>(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND data_type IN ('text', 'character varying', 'json', 'jsonb')
        ORDER BY table_name, ordinal_position
      `)
      assert.ok(columns.rows.length > 0)
      for (const column of columns.rows) {
        assert.match(column.table_name, /^[a-z_]+$/)
        assert.match(column.column_name, /^[a-z_]+$/)
        const leaked = await database!.query<{ leaked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM "${column.table_name}"
             WHERE "${column.column_name}"::text LIKE $1
           ) AS leaked`,
          [`%${MARKER}%`],
        )
        assert.equal(leaked.rows[0]?.leaked, false, `${column.table_name}.${column.column_name}`)
      }
    })
  } finally {
    if (database) await database.end()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.end()
    }
  }
})

function subject(id: number): SubjectInput {
  return {
    id,
    subjectType: 2,
    payload: { id, name: `subject-${id}` },
    contentHash: `subject-hash-${id}`,
    upstreamUpdatedAt: null,
  }
}

function collection(subjectId: number) {
  return {
    payload: { type: 2, ep_status: subjectId },
    contentHash: `collection-hash-${subjectId}`,
    upstreamUpdatedAt: null,
  }
}

function state(
  id: string,
  observedAt: string,
  collectionSubjectIds: readonly number[],
  calendarSubjectIds: readonly number[],
): CompleteStateInput {
  return {
    runId: id,
    observedAt,
    users: [{
      id: userId(),
      upstreamUserId: '42',
      items: collectionSubjectIds.map((subjectId) => ({
        subject: subject(subjectId),
        collection: collection(subjectId),
      })),
    }],
    calendarEntries: calendarSubjectIds.map((subjectId) => ({
      weekdayId: 1,
      subjectId,
      subject: subject(subjectId),
      payload: { weekday: { id: 1 }, subject_id: subjectId },
    })),
  }
}

async function beginRun(authority: PostgresAuthority, id: string, observedAt: string): Promise<void> {
  await authority.beginRun({
    id,
    source: 'scheduled',
    mode: 'shadow',
    stage: 'collection',
    status: 'running',
    startedAt: observedAt,
    heartbeatAt: observedAt,
    gitSha: 'a'.repeat(40),
  })
}

async function rowVersions(database: Pool, subjectId: number): Promise<{ subject: string; collection: string }> {
  const result = await database.query<{ subject_xmin: string; collection_xmin: string }>(`
    SELECT s.xmin::text AS subject_xmin, c.xmin::text AS collection_xmin
    FROM subjects s
    JOIN collection_items c ON c.subject_id = s.id
    WHERE s.id = $1
  `, [subjectId])
  const row = result.rows[0]
  assert.ok(row)
  return { subject: row.subject_xmin, collection: row.collection_xmin }
}

async function collectionDeletedAt(database: Pool, subjectId: number): Promise<string | null> {
  const result = await database.query<{ deleted_at: Date | null }>(
    'SELECT deleted_at FROM collection_items WHERE subject_id = $1',
    [subjectId],
  )
  return result.rows[0]?.deleted_at?.toISOString() ?? null
}

function pending(runIdValue: string, generation: number, hashCharacter: string): PendingPublicationInput {
  const contentHash = hashCharacter.repeat(64)
  return {
    generation,
    contentHash,
    objectKey: `public/snapshots/${generation}-${contentHash}.json`,
    runId: runIdValue,
    createdAt: `2026-08-29T0${generation}:00:00.000Z`,
  }
}

function userId(): string {
  return '10000000-0000-4000-8000-000000000001'
}

function runId(index: number): string {
  return `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}
