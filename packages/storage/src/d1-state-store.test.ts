import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import type {
  CollectionDiffPlanLike,
  CollectionRow,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  PublicationSourceWatermarkV1,
  PublicSnapshotPointerV1,
  PublicationWriteOwner,
  SyncRunRow,
} from './d1-types.ts'
import { D1StateStore, StaleCollectionDiffError } from './d1-state-store.ts'

interface RecordedStatement {
  sql: string
  binds: unknown[]
}

const collectionColumns = [
  'user_id', 'subject_id', 'collection_type', 'rate', 'tags_json', 'comment', 'ep_status',
  'vol_status', 'upstream_updated_at', 'subject_json', 'content_hash', 'state_version',
  'temperature', 'first_seen_at', 'changed_at', 'missing_since', 'deleted_at',
] as const
const syncRunColumns = [
  'instance_id', 'status', 'stage', 'generation', 'collection_count', 'changed_count',
  'missing_count', 'deleted_count', 'media_selected_count', 'media_granted_count',
  'input_hash', 'public_hash', 'result_json', 'error_code', 'started_at', 'heartbeat_at', 'completed_at',
] as const

function publicationOwner(
  publicationId: string,
  attemptToken: string,
): PublicationWriteOwner {
  return {
    publication_id: publicationId,
    attempt_token: attemptToken,
  }
}

function publicationSource(
  publicationId: string,
  observedAt: number,
  contentHash: string,
): PublicationSourceWatermarkV1 {
  return {
    schema_version: 1,
    source_observed_at: observedAt,
    publication_id: publicationId,
    content_hash: contentHash,
  }
}

function result<T = Record<string, unknown>>(changes = 0, rows: T[] = []): D1ResultLike<T> {
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

class RecordingStatement implements D1PreparedStatementLike {
  binds: unknown[] = []

  constructor(
    readonly sql: string,
    private readonly rows: Record<string, unknown>[],
    private readonly resolveFirst?: (binds: unknown[]) => Record<string, unknown> | null,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.binds = values
    return this
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (this.resolveFirst) return this.resolveFirst(this.binds) as T | null
    return (this.rows[0] as T | undefined) ?? null
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return result<T>()
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return result<T>(0, this.rows as T[])
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return []
  }
}

class RecordingD1 implements D1DatabaseLike {
  readonly prepared: RecordingStatement[] = []
  readonly batchCalls: RecordedStatement[][] = []
  rows: Record<string, unknown>[] = []
  readonly insertedCollections = new Set<string>()
  readonly collectionRows = new Map<string, Record<string, unknown>>()
  readonly syncStatuses = new Map<string, string>()
  readonly syncRows = new Map<string, Record<string, unknown>>()
  nextChanges: number[] = []
  throwBeforeBatchAt: number | null = null
  loseCollectionResponseAt: number | null = null
  loseCompleteResponseOnce = false
  loseStartResponseOnce = false
  private batchIndex = 0

  prepare(sql: string): D1PreparedStatementLike {
    const statement = new RecordingStatement(sql, this.rows, (binds) => {
      if (sql.startsWith('SELECT user_id, subject_id') && sql.includes('WHERE user_id = ?')) {
        return this.collectionRows.get(`${binds[0]}:${binds[1]}`) ?? null
      }
      if (sql.startsWith('SELECT instance_id, status') && sql.includes('WHERE instance_id = ?')) {
        return this.syncRows.get(String(binds[0])) ?? null
      }
      if (!sql.startsWith('SELECT status FROM sync_runs')) return this.rows[0] ?? null
      const status = this.syncStatuses.get(String(binds[0]))
      return status === undefined ? null : { status }
    })
    this.prepared.push(statement)
    return statement
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const currentBatch = this.batchIndex++
    const recordedStatements = statements.map((statement) => {
      const recorded = statement as RecordingStatement
      return { sql: recorded.sql, binds: recorded.binds }
    })
    this.batchCalls.push(recordedStatements)
    if (this.throwBeforeBatchAt === currentBatch) throw new Error('simulated D1 batch failure')

    const results = recordedStatements.map(({ sql, binds }) => {
      let changes = this.nextChanges.shift()
      if (changes === undefined && sql.startsWith('INSERT INTO collection_items')) {
        const key = `${binds[0]}:${binds[1]}`
        changes = this.insertedCollections.has(key) ? 0 : 1
        this.insertedCollections.add(key)
        if (changes === 1) {
          this.collectionRows.set(key, Object.fromEntries(collectionColumns.map((column, index) => [column, binds[index]])))
        }
      }
      if (changes === undefined && sql.startsWith('INSERT INTO sync_runs')) {
        const instanceId = String(binds[0])
        changes = this.syncStatuses.has(instanceId) ? 0 : 1
        if (changes === 1) {
          this.syncStatuses.set(instanceId, String(binds[1]))
          this.syncRows.set(instanceId, Object.fromEntries(syncRunColumns.map((column, index) => [column, binds[index]])))
        }
      }
      if (changes === undefined && sql.startsWith("UPDATE sync_runs SET status = 'ok'")) {
        const instanceId = String(binds.at(-1))
        const status = this.syncStatuses.get(instanceId)
        const guarded = sql.includes("status NOT IN ('ok', 'error')")
        changes = status === undefined || (guarded && (status === 'ok' || status === 'error')) ? 0 : 1
        if (changes === 1) this.syncStatuses.set(instanceId, 'ok')
      }
      if (changes === undefined && sql.startsWith("UPDATE sync_runs SET status = 'error'")) {
        const instanceId = String(binds.at(-1))
        const status = this.syncStatuses.get(instanceId)
        const guarded = sql.includes("status NOT IN ('ok', 'error')")
        changes = status === undefined || (guarded && (status === 'ok' || status === 'error')) ? 0 : 1
        if (changes === 1) this.syncStatuses.set(instanceId, 'error')
      }
      if (
        changes === undefined
        && sql.startsWith('UPDATE sync_runs SET stage = ?')
      ) {
        const instanceId = String(binds.at(-1))
        const status = this.syncStatuses.get(instanceId)
        changes = status === undefined || status === 'ok' || status === 'error' ? 0 : 1
      }
      return result<T>(changes ?? 1)
    })

    if (
      this.loseCollectionResponseAt === currentBatch
      && recordedStatements.some(({ sql }) => sql.startsWith('INSERT INTO collection_items'))
    ) {
      this.loseCollectionResponseAt = null
      throw new Error('simulated collection response loss after commit')
    }
    if (
      this.loseStartResponseOnce
      && recordedStatements.some(({ sql }) => sql.startsWith('INSERT INTO sync_runs'))
    ) {
      this.loseStartResponseOnce = false
      throw new Error('simulated start response loss after commit')
    }
    if (
      this.loseCompleteResponseOnce
      && recordedStatements.some(({ sql }) => sql.startsWith("UPDATE sync_runs SET status = 'ok'"))
    ) {
      this.loseCompleteResponseOnce = false
      throw new Error('simulated response loss after commit')
    }
    return results
  }

  async exec(): Promise<{ count: number; duration: number }> {
    return { count: 0, duration: 0 }
  }
}

class SqliteStatement implements D1PreparedStatementLike {
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
    return result<T>(Number(applied.changes))
  }
  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return result<T>(0, this.database.prepare(this.sql).all(...this.binds as SQLInputValue[]) as T[])
  }
  async raw<T = unknown[]>(): Promise<T[]> {
    return this.database.prepare(this.sql).all(...this.binds as SQLInputValue[]).map((row) => Object.values(row) as T)
  }
}

class SqliteD1 implements D1DatabaseLike {
  private readonly database = new DatabaseSync(':memory:')
  constructor() {
    this.database.exec(`
      CREATE TABLE collection_items (
        user_id TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        collection_type INTEGER NOT NULL,
        rate INTEGER,
        tags_json TEXT NOT NULL,
        comment TEXT NOT NULL,
        ep_status INTEGER NOT NULL,
        vol_status INTEGER NOT NULL,
        upstream_updated_at TEXT,
        subject_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
        temperature TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        changed_at INTEGER NOT NULL,
        missing_since INTEGER,
        deleted_at INTEGER,
        PRIMARY KEY (user_id, subject_id)
      );
      CREATE TABLE sync_runs (
        instance_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        generation INTEGER,
        collection_count INTEGER NOT NULL,
        changed_count INTEGER NOT NULL,
        missing_count INTEGER NOT NULL,
        deleted_count INTEGER NOT NULL,
        media_selected_count INTEGER NOT NULL,
        media_granted_count INTEGER NOT NULL,
        input_hash TEXT,
        public_hash TEXT,
        result_json TEXT,
        error_code TEXT,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }
  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteStatement(sql, this.database)
  }
  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: D1ResultLike<T>[] = []
      for (const statement of statements) results.push(await statement.run<T>())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.database.exec(sql)
    return { count: 0, duration: 0 }
  }
}

class PublicationResponseLossD1 extends SqliteD1 {
  loseNextBatchResponse = false

  override async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<D1ResultLike<T>[]> {
    const results = await super.batch<T>(statements)
    if (this.loseNextBatchResponse) {
      this.loseNextBatchResponse = false
      throw new Error('simulated publication watermark response loss')
    }
    return results
  }
}

function collection(overrides: Partial<CollectionRow> = {}): CollectionRow {
  return {
    user_id: 'alice',
    subject_id: 23080,
    collection_type: 3,
    rate: 8,
    tags_json: '["daily"]',
    comment: '',
    ep_status: 4,
    vol_status: 0,
    upstream_updated_at: '2026-07-27T00:00:00Z',
    subject_json: '{"private":false,"subject":null,"subject_type":2}',
    content_hash: 'a'.repeat(64),
    state_version: 1,
    temperature: 'hot',
    first_seen_at: 100,
    changed_at: 100,
    missing_since: null,
    deleted_at: null,
    ...overrides,
  }
}

function emptyPlan(): CollectionDiffPlanLike {
  return {
    inserts: [],
    updates: [],
    unchanged: 1,
    firstMissing: [],
    confirmedDeleted: [],
    restored: [],
  }
}

function syncRun(overrides: Partial<SyncRunRow> = {}): SyncRunRow {
  return {
    instance_id: 'run-1',
    status: 'running',
    stage: 'collections',
    generation: null,
    collection_count: 0,
    changed_count: 0,
    missing_count: 0,
    deleted_count: 0,
    media_selected_count: 0,
    media_granted_count: 0,
    input_hash: null,
    public_hash: null,
    result_json: null,
    error_code: null,
    started_at: 100,
    heartbeat_at: 100,
    completed_at: null,
    ...overrides,
  }
}

test('listCollectionRows selects explicit columns and decodes stable rows', async () => {
  const fake = new RecordingD1()
  fake.rows = [{ ...collection() }]

  const rows = await new D1StateStore(fake, () => 500).listCollectionRows()

  assert.deepEqual(rows, [collection()])
  assert.match(fake.prepared[0]?.sql ?? '', /^SELECT user_id, subject_id, collection_type,/)
  assert.doesNotMatch(fake.prepared[0]?.sql ?? '', /SELECT\s+\*/i)
  assert.match(fake.prepared[0]?.sql ?? '', /ORDER BY user_id, subject_id$/)
})

test('listCollectionRows rejects corrupt persisted JSON', async () => {
  const fake = new RecordingD1()
  fake.rows = [{ ...collection({ tags_json: '{broken' }) }]
  await assert.rejects(
    new D1StateStore(fake).listCollectionRows(),
    /Invalid collection_items\.tags_json/,
  )
})

test('listCollectionRows rejects zero and negative state revisions', async () => {
  for (const stateVersion of [0, -1]) {
    const fake = new RecordingD1()
    fake.rows = [{ ...collection({ state_version: stateVersion }) }]
    await assert.rejects(
      new D1StateStore(fake).listCollectionRows(),
      /Invalid collection_items\.state_version/,
    )
  }
})

test('listSubjectMediaRows decodes explicit scheduling state and rejects corrupt rows', async () => {
  const database = new RecordingD1()
  database.rows = [{
    subject_id: 23080,
    detail_json: null,
    detail_hash: null,
    media_hash: null,
    nsfw: 0,
    source_image_common_url: null,
    source_image_large_url: null,
    r2_image_common_key: null,
    r2_image_large_key: null,
    checked_at: 100,
    next_refresh_at: 200,
    retry_count: 0,
    retry_after: null,
    error_code: null,
  }]
  const store = new D1StateStore(database)
  assert.deepEqual(await store.listSubjectMediaRows(), database.rows)
  assert.match(database.prepared.at(-1)?.sql ?? '', /^SELECT subject_id, detail_json/)

  database.rows = [{ ...database.rows[0], nsfw: 2 }]
  await assert.rejects(store.listSubjectMediaRows(), /subject_media\.nsfw/)
})

test('subject media writes report their own classified error-code column', async () => {
  const store = new D1StateStore(new RecordingD1())
  await assert.rejects(
    store.putSubjectMediaRow({
      subject_id: 23080,
      detail_json: null,
      detail_hash: null,
      media_hash: null,
      nsfw: 0,
      source_image_common_url: null,
      source_image_large_url: null,
      r2_image_common_key: null,
      r2_image_large_key: null,
      checked_at: null,
      next_refresh_at: null,
      retry_count: 0,
      retry_after: null,
      error_code: 'raw upstream body',
    }),
    /subject_media\.error_code must be a classified error code/,
  )
})

test('collection insert plans require the exact initial state revision', async () => {
  for (const stateVersion of [0, -1, 2]) {
    const plan = emptyPlan()
    plan.inserts = [collection({ state_version: stateVersion })]
    await assert.rejects(
      new D1StateStore(new RecordingD1()).applyCollectionDiff(plan),
      /Invalid collection insert state_version/,
    )
  }
})

test('applyCollectionDiff performs zero D1 batches for unchanged rows', async () => {
  const fake = new RecordingD1()
  const result = await new D1StateStore(fake).applyCollectionDiff(emptyPlan())
  assert.deepEqual(result, { rowsWritten: 0 })
  assert.equal(fake.batchCalls.length, 0)
})

test('applyCollectionDiff uses one prepared positional statement for one changed row', async () => {
  const fake = new RecordingD1()
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.updates = [collection({ rate: 9, content_hash: 'b'.repeat(64), state_version: 2, changed_at: 200 })]

  assert.deepEqual(await new D1StateStore(fake).applyCollectionDiff(plan), { rowsWritten: 1 })
  assert.equal(fake.batchCalls.length, 1)
  assert.equal(fake.batchCalls[0]?.length, 1)
  assert.match(fake.batchCalls[0]?.[0]?.sql ?? '', /^UPDATE collection_items SET collection_type = \?/)
  assert.equal((fake.batchCalls[0]?.[0]?.sql.match(/\?/g) ?? []).length, fake.batchCalls[0]?.[0]?.binds.length)
  assert.deepEqual(fake.batchCalls[0]?.[0]?.binds.slice(-3, -1), ['alice', 23080])
  assert.doesNotMatch(fake.batchCalls[0]?.[0]?.sql ?? '', /last_seen/i)
})

test('applyCollectionDiff checkpoints replay state in the same D1 batch as collection mutation', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  await store.startSyncRun(syncRun({ instance_id: 'checkpointed-diff' }))
  fake.batchCalls.length = 0
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.updates = [collection({ rate: 9, content_hash: 'b'.repeat(64), state_version: 2, changed_at: 200 })]

  await store.applyCollectionDiff(plan, {
    instanceId: 'checkpointed-diff',
    update: {
      stage: 'collections',
      heartbeat_at: 200,
      changed_count: 1,
      result_json: '{"schema_version":1,"collection":{}}',
    },
  })

  assert.equal(fake.batchCalls.length, 1)
  assert.equal(fake.batchCalls[0]?.length, 2)
  assert.match(fake.batchCalls[0]?.[0]?.sql ?? '', /^UPDATE collection_items/)
  assert.match(fake.batchCalls[0]?.[1]?.sql ?? '', /^UPDATE sync_runs SET stage = \?/)
})

test('real adapter revalidates a persisted losing checkpoint before accepting replay', async () => {
  const database = new SqliteD1()
  const store = new D1StateStore(database)
  await store.startSyncRun(syncRun({
    instance_id: 'stale-checkpoint',
    input_hash: 'a'.repeat(64),
  }))
  const initial = emptyPlan()
  initial.unchanged = 0
  initial.inserts = [collection()]
  await store.applyCollectionDiff(initial)
  const losing = emptyPlan()
  losing.unchanged = 0
  losing.updates = [collection({
    rate: 9,
    content_hash: 'b'.repeat(64),
    state_version: 3,
    changed_at: 200,
  })]
  const checkpoint = {
    instanceId: 'stale-checkpoint',
    update: {
      stage: 'collections_pending',
      heartbeat_at: 200,
      input_hash: 'a'.repeat(64),
      result_json: '{"schema_version":1,"collection":{"losing":true}}',
    },
  }

  await assert.rejects(
    store.applyCollectionDiff(losing, checkpoint),
    /Stale collection diff conflict/,
  )
  assert.equal((await store.getSyncRun('stale-checkpoint'))?.result_json, checkpoint.update.result_json)

  await assert.rejects(
    store.applyCollectionDiff(losing, checkpoint),
    /Stale collection diff conflict/,
  )
  assert.equal((await store.listCollectionRows())[0]?.content_hash, 'a'.repeat(64))
})

test('collection insert replay finishes after a batch commits but its response is lost', async () => {
  const fake = new RecordingD1()
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.inserts = Array.from({ length: 121 }, (_, subjectId) => collection({ subject_id: subjectId + 1 }))
  fake.loseCollectionResponseAt = 1

  await assert.rejects(
    new D1StateStore(fake).applyCollectionDiff(plan),
    /collection response loss after commit/,
  )
  assert.equal(fake.insertedCollections.size, 100)

  const replay = await new D1StateStore(fake).applyCollectionDiff(plan)
  assert.equal(replay.rowsWritten, 21)
  assert.equal(fake.insertedCollections.size, 121)
})

test('collection inserts replay safely after a committed chunk and a later batch failure', async () => {
  const fake = new RecordingD1()
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.inserts = Array.from({ length: 121 }, (_, subjectId) => collection({ subject_id: subjectId + 1 }))
  fake.throwBeforeBatchAt = 1

  await assert.rejects(new D1StateStore(fake).applyCollectionDiff(plan), /simulated D1 batch failure/)
  assert.equal(fake.insertedCollections.size, 50)
  assert.match(fake.batchCalls[0]?.[0]?.sql ?? '', /ON CONFLICT\(user_id, subject_id\) DO UPDATE SET/)
  assert.match(fake.batchCalls[0]?.[0]?.sql ?? '', /excluded\.changed_at.*excluded\.content_hash.*COLLATE BINARY/)

  fake.throwBeforeBatchAt = null
  const replay = await new D1StateStore(fake).applyCollectionDiff(plan)
  assert.equal(replay.rowsWritten, 71)
  assert.equal(fake.insertedCollections.size, 121)
})

test('applyCollectionDiff maps every transition to correct SQL and binds in stable order', async () => {
  const fake = new RecordingD1()
  const plan: CollectionDiffPlanLike = {
    inserts: [collection({ user_id: 'zoe', subject_id: 9 })],
    updates: [collection({ user_id: 'bob', subject_id: 8, rate: 9, state_version: 2 })],
    unchanged: 7,
    firstMissing: [collection({ user_id: 'alice', subject_id: 7, state_version: 2, missing_since: 200 })],
    confirmedDeleted: [collection({ user_id: 'alice', subject_id: 6, state_version: 2, missing_since: 100, deleted_at: 200 })],
    restored: [collection({ user_id: 'alice', subject_id: 5, state_version: 2, missing_since: null, deleted_at: null })],
  }

  const result = await new D1StateStore(fake).applyCollectionDiff(plan)
  const statements = fake.batchCalls.flat()

  assert.equal(result.rowsWritten, 5)
  assert.equal(statements.length, 5)
  assert.deepEqual(statements.map(({ sql, binds }) => {
    if (sql.startsWith('INSERT')) return binds.slice(0, 2)
    if (sql.startsWith('UPDATE collection_items SET deleted_at')) return binds.slice(2, 4)
    if (sql.startsWith('UPDATE collection_items SET missing_since')) return binds.slice(2, 4)
    return binds.slice(-3, -1)
  }), [
    ['alice', 5],
    ['alice', 6],
    ['alice', 7],
    ['bob', 8],
    ['zoe', 9],
  ])
  assert.match(statements[0]?.sql ?? '', /^UPDATE collection_items SET collection_type = \?/)
  assert.match(statements[1]?.sql ?? '', /^UPDATE collection_items SET deleted_at = \?/)
  assert.deepEqual(statements[1]?.binds, [200, 2, 'alice', 6, 1])
  assert.match(statements[1]?.sql ?? '', /state_version = \?$/)
  assert.match(statements[2]?.sql ?? '', /^UPDATE collection_items SET missing_since = \?/)
  assert.deepEqual(statements[2]?.binds, [200, 2, 'alice', 7, 1])
  assert.match(statements[2]?.sql ?? '', /state_version = \?$/)
  assert.match(statements[3]?.sql ?? '', /^UPDATE collection_items SET collection_type = \?/)
  assert.match(statements[4]?.sql ?? '', /^INSERT INTO collection_items \(/)
})

test('collection CAS rejects stale missing, deletion and restore transitions', async () => {
  const fake = new RecordingD1()
  fake.nextChanges = [0, 0, 0]
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.firstMissing = [collection({ subject_id: 1, state_version: 2, missing_since: 200 })]
  plan.confirmedDeleted = [collection({ subject_id: 2, state_version: 2, missing_since: 100, deleted_at: 200 })]
  plan.restored = [collection({ subject_id: 3, state_version: 2, changed_at: 150 })]

  await assert.rejects(
    new D1StateStore(fake).applyCollectionDiff(plan),
    /Stale collection diff conflict: alice:1/,
  )
  const statements = fake.batchCalls.flat()
  assert.ok(statements.every(({ sql }) => /state_version = \?$/.test(sql)))
})

test('business update zero-change conflicts when current state differs', async () => {
  const fake = new RecordingD1()
  fake.nextChanges = [0]
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.updates = [collection({ state_version: 2, changed_at: 200, content_hash: 'b'.repeat(64) })]

  await assert.rejects(
    new D1StateStore(fake).applyCollectionDiff(plan),
    /Stale collection diff conflict: alice:23080/,
  )
  const statement = fake.batchCalls[0]?.[0]
  assert.match(statement?.sql ?? '', /state_version = \?$/)
  assert.deepEqual(statement?.binds.slice(-3), ['alice', 23080, 1])
})

test('state_version CAS rejects stale transitions across business, missing, delete and restore sequences', async () => {
  const database = new SqliteD1()
  const store = new D1StateStore(database)
  const initial = collection({ state_version: 1, changed_at: 100 })
  const insert = emptyPlan()
  insert.unchanged = 0
  insert.inserts = [initial]
  assert.equal((await store.applyCollectionDiff(insert)).rowsWritten, 1)

  const business = collection({
    rate: 9,
    content_hash: 'b'.repeat(64),
    state_version: 2,
    changed_at: 100,
  })
  const businessPlan = emptyPlan()
  businessPlan.unchanged = 0
  businessPlan.updates = [business]
  assert.equal((await store.applyCollectionDiff(businessPlan)).rowsWritten, 1)

  const staleMissingPlan = emptyPlan()
  staleMissingPlan.unchanged = 0
  staleMissingPlan.firstMissing = [collection({ state_version: 2, missing_since: 101 })]
  await assert.rejects(
    store.applyCollectionDiff(staleMissingPlan),
    /Stale collection diff conflict: alice:23080/,
  )

  const missingPlan = emptyPlan()
  missingPlan.unchanged = 0
  missingPlan.firstMissing = [{ ...business, state_version: 3, missing_since: 101 }]
  assert.equal((await store.applyCollectionDiff(missingPlan)).rowsWritten, 1)
  const deletePlan = emptyPlan()
  deletePlan.unchanged = 0
  deletePlan.confirmedDeleted = [{ ...business, state_version: 4, missing_since: 101, deleted_at: 102 }]
  assert.equal((await store.applyCollectionDiff(deletePlan)).rowsWritten, 1)
  const restorePlan = emptyPlan()
  restorePlan.unchanged = 0
  restorePlan.restored = [{ ...business, state_version: 5, missing_since: null, deleted_at: null }]
  assert.equal((await store.applyCollectionDiff(restorePlan)).rowsWritten, 1)
  const newMissingPlan = emptyPlan()
  newMissingPlan.unchanged = 0
  newMissingPlan.firstMissing = [{ ...business, state_version: 6, missing_since: 103 }]
  assert.equal((await store.applyCollectionDiff(newMissingPlan)).rowsWritten, 1)
  const newDeletePlan = emptyPlan()
  newDeletePlan.unchanged = 0
  newDeletePlan.confirmedDeleted = [{ ...business, state_version: 7, missing_since: 103, deleted_at: 104 }]
  assert.equal((await store.applyCollectionDiff(newDeletePlan)).rowsWritten, 1)
  await assert.rejects(
    store.applyCollectionDiff(restorePlan),
    /Stale collection diff conflict: alice:23080/,
  )

  const [final] = await store.listCollectionRows()
  assert.equal(final?.state_version, 7)
  assert.equal(final?.deleted_at, 104)
})

test('divergent initial inserts converge without advancing the initial revision', async () => {
  const older = collection({ changed_at: 100, content_hash: 'a'.repeat(64), rate: 7 })
  const newer = collection({ changed_at: 101, content_hash: 'b'.repeat(64), rate: 9 })
  const equalTimeWinner = collection({ changed_at: 100, content_hash: 'f'.repeat(64), rate: 10 })
  const asInsert = (row: CollectionRow): CollectionDiffPlanLike => ({
    inserts: [row],
    updates: [],
    unchanged: 0,
    firstMissing: [],
    confirmedDeleted: [],
    restored: [],
  })

  for (const order of [[older, newer], [newer, older]]) {
    const store = new D1StateStore(new SqliteD1())
    await store.applyCollectionDiff(asInsert(order[0]!))
    if (order[1] === older) {
      await assert.rejects(
        store.applyCollectionDiff(asInsert(order[1])),
        /Stale collection diff conflict: alice:23080/,
      )
    } else {
      await store.applyCollectionDiff(asInsert(order[1]!))
    }
    assert.equal((await store.listCollectionRows())[0]?.content_hash, newer.content_hash)
    assert.equal((await store.listCollectionRows())[0]?.state_version, 1)
    assert.equal((await store.applyCollectionDiff(asInsert(newer))).rowsWritten, 0)
  }

  for (const order of [[older, equalTimeWinner], [equalTimeWinner, older]]) {
    const store = new D1StateStore(new SqliteD1())
    await store.applyCollectionDiff(asInsert(order[0]!))
    if (order[1] === older) {
      await assert.rejects(
        store.applyCollectionDiff(asInsert(order[1])),
        /Stale collection diff conflict: alice:23080/,
      )
    } else {
      await store.applyCollectionDiff(asInsert(order[1]!))
    }
    assert.equal((await store.listCollectionRows())[0]?.content_hash, equalTimeWinner.content_hash)
    assert.equal((await store.listCollectionRows())[0]?.state_version, 1)
  }
})

test('winning initial insert replay accepts an earlier preserved first_seen_at only', async () => {
  const store = new D1StateStore(new SqliteD1())
  const first = collection({ first_seen_at: 100, changed_at: 100, content_hash: 'a'.repeat(64), rate: 7 })
  const winner = collection({ first_seen_at: 200, changed_at: 101, content_hash: 'b'.repeat(64), rate: 9 })
  const asInsert = (row: CollectionRow): CollectionDiffPlanLike => ({
    inserts: [row],
    updates: [],
    unchanged: 0,
    firstMissing: [],
    confirmedDeleted: [],
    restored: [],
  })

  assert.equal((await store.applyCollectionDiff(asInsert(first))).rowsWritten, 1)
  assert.equal((await store.applyCollectionDiff(asInsert(winner))).rowsWritten, 1)
  assert.equal((await store.applyCollectionDiff(asInsert(winner))).rowsWritten, 0)
  const [stored] = await store.listCollectionRows()
  assert.equal(stored?.first_seen_at, 100)
  assert.equal(stored?.state_version, 1)
  assert.equal(stored?.missing_since, null)
  assert.equal(stored?.deleted_at, null)
})

test('delayed insert after missing and deletion cannot clear transitioned state', async () => {
  const store = new D1StateStore(new SqliteD1())
  const initial = collection({ changed_at: 100 })
  const insert = emptyPlan()
  insert.inserts = [initial]
  await store.applyCollectionDiff(insert)

  const missing = emptyPlan()
  missing.firstMissing = [{ ...initial, state_version: 2, missing_since: 101 }]
  await store.applyCollectionDiff(missing)
  const deleted = emptyPlan()
  deleted.confirmedDeleted = [{ ...initial, state_version: 3, missing_since: 101, deleted_at: 102 }]
  await store.applyCollectionDiff(deleted)

  const delayed = emptyPlan()
  delayed.inserts = [collection({ changed_at: 200, content_hash: 'f'.repeat(64), rate: 10 })]
  await assert.rejects(
    store.applyCollectionDiff(delayed),
    /Stale collection diff conflict: alice:23080/,
  )
  const [current] = await store.listCollectionRows()
  assert.equal(current?.state_version, 3)
  assert.equal(current?.missing_since, 101)
  assert.equal(current?.deleted_at, 102)
})

test('overlapping revision plans force the loser to re-read and replan', async () => {
  const store = new D1StateStore(new SqliteD1())
  const initial = collection()
  const insert = emptyPlan()
  insert.inserts = [initial]
  await store.applyCollectionDiff(insert)

  const winner = emptyPlan()
  winner.updates = [{ ...initial, state_version: 2, rate: 9, content_hash: 'b'.repeat(64) }]
  const loser = emptyPlan()
  loser.updates = [{ ...initial, state_version: 2, rate: 10, content_hash: 'c'.repeat(64) }]
  await store.applyCollectionDiff(winner)
  await assert.rejects(store.applyCollectionDiff(loser), (error: unknown) => {
    assert.equal(error instanceof StaleCollectionDiffError, true)
    assert.equal((error as StaleCollectionDiffError).code, 'STALE_COLLECTION_DIFF')
    assert.equal((error as StaleCollectionDiffError).userId, 'alice')
    assert.equal((error as StaleCollectionDiffError).subjectId, 23080)
    assert.equal((error as Error).message, 'Stale collection diff conflict: alice:23080')
    return true
  })
})

test('identical applied collection transition replay is a safe zero-write no-op', async () => {
  const store = new D1StateStore(new SqliteD1())
  const initial = collection()
  const insert = emptyPlan()
  insert.inserts = [initial]
  await store.applyCollectionDiff(insert)

  const update = emptyPlan()
  update.updates = [{ ...initial, state_version: 2, rate: 9, content_hash: 'b'.repeat(64) }]
  assert.equal((await store.applyCollectionDiff(update)).rowsWritten, 1)
  assert.equal((await store.applyCollectionDiff(update)).rowsWritten, 0)
})

test('applyCollectionDiff splits deterministic writes into batches of at most 50', async () => {
  const fake = new RecordingD1()
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.inserts = Array.from({ length: 121 }, (_, index) =>
    collection({ user_id: index % 2 ? 'bob' : 'alice', subject_id: 121 - index }))

  const result = await new D1StateStore(fake).applyCollectionDiff(plan)

  assert.equal(result.rowsWritten, 121)
  assert.deepEqual(fake.batchCalls.map((batch) => batch.length), [50, 50, 21])
  const keys = fake.batchCalls.flat().map(({ binds }) => `${binds[0]}:${binds[1]}`)
  assert.deepEqual(keys, [...keys].sort((left, right) => {
    const [leftUser, leftSubject] = left.split(':')
    const [rightUser, rightSubject] = right.split(':')
    if (leftUser !== rightUser) return (leftUser ?? '') < (rightUser ?? '') ? -1 : 1
    return Number(leftSubject) - Number(rightSubject)
  }))
})

test('app_state writes canonical version-one envelopes and reads their values', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake, () => 500)
  await store.putAppState('public:pending', { z: 2, a: 1 })

  const statement = fake.batchCalls[0]?.[0]
  assert.match(statement?.sql ?? '', /^INSERT INTO app_state \(key, value_json, updated_at\)/)
  assert.deepEqual(statement?.binds, [
    'public:pending',
    '{"schema_version":1,"value":{"a":1,"z":2}}',
    500,
  ])

  fake.rows = [{ value_json: statement?.binds[1] }]
  assert.deepEqual(await store.getAppState('public:pending', (value) => value), { a: 1, z: 2 })
})

test('app_state rejects unknown versions and corrupt JSON', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  fake.rows = [{ value_json: '{"schema_version":2,"value":{}}' }]
  await assert.rejects(store.getAppState('x', (value) => value), /Unsupported app_state schema_version/)
  fake.rows = [{ value_json: '{broken' }]
  await assert.rejects(store.getAppState('x', (value) => value), /Invalid app_state JSON/)
})

test('getAppState requires a runtime decoder while raw reads are explicit', async () => {
  const fake = new RecordingD1()
  fake.rows = [{ value_json: '{"schema_version":1,"value":{"ok":true}}' }]
  const store = new D1StateStore(fake)
  if (false) {
    // @ts-expect-error typed app-state reads require a runtime decoder
    await store.getAppState('x')
  }
  assert.deepEqual(await store.getAppStateUnknown('x'), { ok: true })
})

test('app_state decoder rejects invalid per-key values at runtime', async () => {
  const fake = new RecordingD1()
  fake.rows = [{ value_json: '{"schema_version":1,"value":{"generation":"bad"}}' }]
  const decodePointer = (value: unknown): { generation: number } => {
    if (
      typeof value !== 'object'
      || value === null
      || typeof (value as { generation?: unknown }).generation !== 'number'
    ) throw new Error('Invalid public pointer state')
    return value as { generation: number }
  }
  await assert.rejects(
    new D1StateStore(fake).getAppState('public:pending', decodePointer),
    /Invalid public pointer state/,
  )
})

test('app_state monotonic writes reject older cursor versions and cleanup exact artifact keys', async () => {
  const store = new D1StateStore(new SqliteD1())
  const key = 'media:cold-cursor'

  assert.equal(await store.putAppStateIfNewer(key, { subject_ids: [1] }, 10), true)
  assert.equal(await store.putAppStateIfNewer(key, { subject_ids: [2] }, 9), false)
  assert.deepEqual(await store.getAppState(key, (value) => value), { subject_ids: [1] })
  assert.equal(await store.putAppStateIfNewer(key, { subject_ids: [1] }, 10), true)
  assert.equal(await store.putAppStateIfNewer(key, { subject_ids: [2] }, 10), false)
  assert.equal(await store.putAppStateIfNewer(key, { subject_ids: [3] }, 11), true)

  await store.putAppState('sync:artifact:run:hash:0', 'chunk-0')
  await store.putAppState('sync:artifact:run:hash:1', 'chunk-1')
  await store.deleteAppStateKeys([
    'sync:artifact:run:hash:0',
    'sync:artifact:run:hash:1',
  ])
  assert.equal(await store.getAppStateUnknown('sync:artifact:run:hash:0'), undefined)
  assert.equal(await store.getAppStateUnknown('sync:artifact:run:hash:1'), undefined)
})

test('publication app_state persists versioned pending candidates and atomically promotes the exact candidate', async () => {
  const store = new D1StateStore(new SqliteD1())
  const candidate: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 1,
    content_hash: 'a'.repeat(64),
    r2_key: `snapshots/v1/1-${'a'.repeat(64)}.json`,
    published_at: 100,
  }
  const source = publicationSource('initial-publisher', 100, candidate.content_hash)

  assert.equal(await store.commitPendingPublication(candidate, source), true)
  assert.deepEqual(await store.getPendingPublication(), candidate)
  assert.equal(await store.getVerifiedPublication(), undefined)

  const owner = publicationOwner('initial-publisher', 'attempt-1')
  assert.equal(await store.claimPublicationWrite(candidate, owner, source), 'claimed')
  await store.markPublicationPublished(candidate, owner, source)

  assert.deepEqual(await store.getVerifiedPublication(), candidate)
  assert.equal(await store.getPendingPublication(), undefined)
})

test('publication pending allocation is monotonic, exact-replay idempotent, and supersedes an unclaimed conflict', async () => {
  const store = new D1StateStore(new SqliteD1())
  const first: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 1,
    content_hash: 'b'.repeat(64),
    r2_key: `snapshots/v1/1-${'b'.repeat(64)}.json`,
    published_at: 200,
  }
  const conflict: PublicSnapshotPointerV1 = {
    ...first,
    content_hash: 'c'.repeat(64),
    r2_key: `snapshots/v1/1-${'c'.repeat(64)}.json`,
  }
  const firstSource = publicationSource('workflow-a', 200, first.content_hash)
  const conflictSource = publicationSource('workflow-b', 201, conflict.content_hash)

  assert.equal(await store.commitPendingPublication(first, firstSource), true)
  assert.equal(await store.commitPendingPublication(first, firstSource), true)
  assert.equal(await store.commitPendingPublication(conflict, conflictSource), true)
  assert.deepEqual(await store.getPendingPublication(), conflict)
})

test('publication app_state rejects malformed pointers before publication can continue', async () => {
  const store = new D1StateStore(new SqliteD1())
  await store.putAppState('public:pending', {
    schema_version: 1,
    generation: 1,
    content_hash: 'a'.repeat(64),
    r2_key: 'snapshots/v1/wrong.json',
    published_at: 1,
  })

  await assert.rejects(store.getPendingPublication(), /publication object key/)
})

test('publication authorization rejects stale and same-generation conflicting candidates across app_state keys', async () => {
  const store = new D1StateStore(new SqliteD1())
  const verified: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 5,
    content_hash: 'a'.repeat(64),
    r2_key: `snapshots/v1/5-${'a'.repeat(64)}.json`,
    published_at: 100,
  }
  const stale: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 4,
    content_hash: 'b'.repeat(64),
    r2_key: `snapshots/v1/4-${'b'.repeat(64)}.json`,
    published_at: 101,
  }
  const sameGenerationConflict: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 5,
    content_hash: 'c'.repeat(64),
    r2_key: `snapshots/v1/5-${'c'.repeat(64)}.json`,
    published_at: 102,
  }
  await store.putAppStateIfNewer('public:verified', verified, verified.generation)
  const verifiedSource = publicationSource('workflow-verified', 100, verified.content_hash)
  assert.equal(await store.cleanupStalePendingPublication(verified, verifiedSource), 'clean')
  const staleSource = publicationSource('workflow-stale', 99, stale.content_hash)
  const conflictSource = publicationSource(
    'workflow-conflict',
    101,
    sameGenerationConflict.content_hash,
  )

  assert.equal(await store.commitPendingPublication(stale, staleSource), false)
  assert.equal(
    await store.commitPendingPublication(sameGenerationConflict, conflictSource),
    false,
  )
  assert.equal(await store.getPendingPublication(), undefined)
  assert.equal(await store.confirmPublicationAuthorized(stale, staleSource), 'stale')
  assert.equal(
    await store.confirmPublicationAuthorized(sameGenerationConflict, conflictSource),
    'conflict',
  )
  assert.equal(
    await store.confirmPublicationAuthorized(verified, verifiedSource),
    'already_verified',
  )
})

test('publication authorization permits only the exact next generation and detects verified advancement', async () => {
  const store = new D1StateStore(new SqliteD1())
  const verified: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 8,
    content_hash: 'd'.repeat(64),
    r2_key: `snapshots/v1/8-${'d'.repeat(64)}.json`,
    published_at: 200,
  }
  const candidate: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 9,
    content_hash: 'e'.repeat(64),
    r2_key: `snapshots/v1/9-${'e'.repeat(64)}.json`,
    published_at: 201,
  }
  const newer: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 10,
    content_hash: 'f'.repeat(64),
    r2_key: `snapshots/v1/10-${'f'.repeat(64)}.json`,
    published_at: 202,
  }
  await store.putAppStateIfNewer('public:verified', verified, verified.generation)
  const source = publicationSource('stale-publisher', 201, candidate.content_hash)

  assert.equal(await store.commitPendingPublication(candidate, source), true)
  assert.equal(await store.confirmPublicationAuthorized(candidate, source), 'authorized')
  const owner = publicationOwner('stale-publisher', 'attempt-1')
  assert.equal(await store.claimPublicationWrite(candidate, owner, source), 'claimed')

  await store.putAppStateIfNewer('public:verified', newer, newer.generation)

  assert.equal(await store.confirmPublicationAuthorized(candidate, source), 'conflict')
  await assert.rejects(
    store.markPublicationPublished(candidate, owner, source),
    /write claim conflict/,
  )
  assert.deepEqual(await store.getVerifiedPublication(), newer)
  assert.deepEqual(await store.getPendingPublication(), candidate)
})

test('publication write claims exclusively fence pointer mutation and verified promotion', async () => {
  let now = 1_000
  const store = new D1StateStore(new SqliteD1(), () => now)
  const candidate: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 1,
    content_hash: '9'.repeat(64),
    r2_key: `snapshots/v1/1-${'9'.repeat(64)}.json`,
    published_at: 300,
  }
  const source = publicationSource('publisher-a', 300, candidate.content_hash)
  await store.commitPendingPublication(candidate, source)
  const ownerA = publicationOwner('publisher-a', 'attempt-a')
  const overlapA = publicationOwner('publisher-a', 'attempt-b')
  const ownerB = publicationOwner('publisher-b', 'attempt-a')

  assert.equal(await store.claimPublicationWrite(candidate, ownerA, source), 'claimed')
  assert.equal(await store.claimPublicationWrite(candidate, ownerA, source), 'claimed')
  assert.equal(await store.claimPublicationWrite(candidate, overlapA, source), 'busy')
  assert.equal(await store.claimPublicationWrite(candidate, ownerB, source), 'conflict')
  assert.equal(await store.confirmPublicationWrite(candidate, ownerA, source), 'active')
  await assert.rejects(
    store.markPublicationPublished(candidate, overlapA, source),
    /write claim conflict/,
  )
  assert.deepEqual(await store.getPendingPublication(), candidate)
  assert.equal(await store.getVerifiedPublication(), undefined)

  now += 60
  assert.equal(await store.confirmPublicationWrite(candidate, ownerA, source), 'expired')
  assert.equal(await store.claimPublicationWrite(candidate, overlapA, source), 'claimed')
  assert.equal(await store.confirmPublicationWrite(candidate, ownerA, source), 'conflict')
  await assert.rejects(
    store.markPublicationPublished(candidate, ownerA, source),
    /write claim conflict/,
  )
  await store.releasePublicationWrite(candidate, ownerA)
  assert.equal(await store.confirmPublicationWrite(candidate, overlapA, source), 'active')
  await store.markPublicationPublished(candidate, overlapA, source)

  assert.equal(await store.getPendingPublication(), undefined)
  assert.deepEqual(await store.getVerifiedPublication(), candidate)
})

test('publication write lease permits post-expiry takeover after adapter reconstruction', async () => {
  const database = new SqliteD1()
  let now = 2_000
  const initial = new D1StateStore(database, () => now)
  const candidate: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 1,
    content_hash: '8'.repeat(64),
    r2_key: `snapshots/v1/1-${'8'.repeat(64)}.json`,
    published_at: 301,
  }
  const firstAttempt = publicationOwner('stable-workflow-claim', 'attempt-a')
  const replayAttempt = publicationOwner('stable-workflow-claim', 'attempt-b')
  const source = publicationSource('stable-workflow-claim', 301, candidate.content_hash)
  await initial.commitPendingPublication(candidate, source)
  assert.equal(
    await initial.claimPublicationWrite(candidate, firstAttempt, source),
    'claimed',
  )

  const replay = new D1StateStore(database, () => now)
  assert.equal(
    await replay.claimPublicationWrite(candidate, replayAttempt, source),
    'busy',
  )
  now += 60
  assert.equal(
    await replay.claimPublicationWrite(candidate, replayAttempt, source),
    'claimed',
  )
  assert.equal(
    await replay.confirmPublicationWrite(candidate, firstAttempt, source),
    'conflict',
  )
  await replay.markPublicationPublished(candidate, replayAttempt, source)
  assert.deepEqual(await replay.getVerifiedPublication(), candidate)
})

test('publication write lease rejects non-integer and non-ISO-representable clocks', async () => {
  const database = new SqliteD1()
  const candidate: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 1,
    content_hash: '7'.repeat(64),
    r2_key: `snapshots/v1/1-${'7'.repeat(64)}.json`,
    published_at: 302,
  }
  const source = publicationSource('clock-validation', 302, candidate.content_hash)
  await new D1StateStore(database, () => 1).commitPendingPublication(candidate, source)
  const owner = publicationOwner('clock-validation', 'attempt-a')

  await assert.rejects(
    new D1StateStore(database, () => 1.5).claimPublicationWrite(candidate, owner, source),
    /publication lease time/,
  )
  await assert.rejects(
    new D1StateStore(database, () => Number.MAX_SAFE_INTEGER)
      .claimPublicationWrite(candidate, owner, source),
    /publication lease time/,
  )

  const validStore = new D1StateStore(database, () => 1)
  await validStore.putAppState('public:write-claim', {
    candidate,
    ...owner,
    expires_at: Number.MAX_SAFE_INTEGER,
  })
  await assert.rejects(
    validStore.confirmPublicationWrite(candidate, owner, source),
    /publication lease time/,
  )
})

test('a newer publication source waits for an active owner then supersedes it after expiry', async () => {
  const database = new SqliteD1()
  let now = 3_000
  const store = new D1StateStore(database, () => now)
  const verified: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 5,
    content_hash: '1'.repeat(64),
    r2_key: `snapshots/v1/5-${'1'.repeat(64)}.json`,
    published_at: 400,
  }
  const pendingB: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 6,
    content_hash: '2'.repeat(64),
    r2_key: `snapshots/v1/6-${'2'.repeat(64)}.json`,
    published_at: 401,
  }
  const pendingC: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 6,
    content_hash: '3'.repeat(64),
    r2_key: `snapshots/v1/6-${'3'.repeat(64)}.json`,
    published_at: 402,
  }
  const ownerB = publicationOwner('workflow-b', 'attempt-b')
  const sourceB = publicationSource('workflow-b', 401, pendingB.content_hash)
  const sourceC = publicationSource('workflow-c', 402, pendingC.content_hash)
  await store.putAppStateIfNewer('public:verified', verified, verified.generation)
  assert.equal(await store.commitPendingPublication(pendingB, sourceB), true)
  assert.equal(await store.claimPublicationWrite(pendingB, ownerB, sourceB), 'claimed')

  assert.equal(await store.commitPendingPublication(pendingC, sourceC), false)
  assert.deepEqual(await store.getPendingPublication(), pendingB)

  now += 60
  assert.equal(await store.commitPendingPublication(pendingC, sourceC), true)
  assert.deepEqual(await store.getPendingPublication(), pendingC)
  assert.equal(
    await store.confirmPublicationWrite(pendingB, ownerB, sourceB),
    'conflict',
  )
  await assert.rejects(
    store.markPublicationPublished(pendingB, ownerB, sourceB),
    /source conflict|write claim conflict/,
  )
  await store.releasePublicationWrite(pendingB, ownerB)
  assert.deepEqual(await store.getPendingPublication(), pendingC)
})

test('a newer verified no-op waits for an active pending owner then fences it after expiry', async () => {
  const database = new SqliteD1()
  let now = 4_000
  const store = new D1StateStore(database, () => now)
  const verified: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 7,
    content_hash: '4'.repeat(64),
    r2_key: `snapshots/v1/7-${'4'.repeat(64)}.json`,
    published_at: 500,
  }
  const pending: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 8,
    content_hash: '5'.repeat(64),
    r2_key: `snapshots/v1/8-${'5'.repeat(64)}.json`,
    published_at: 501,
  }
  const owner = publicationOwner('workflow-b', 'attempt-b')
  const initialSource = publicationSource('workflow-a-initial', 500, verified.content_hash)
  const pendingSource = publicationSource('workflow-b', 501, pending.content_hash)
  const restoredSource = publicationSource('workflow-a-restored', 502, verified.content_hash)
  await store.putAppStateIfNewer('public:verified', verified, verified.generation)
  assert.equal(
    await store.cleanupStalePendingPublication(verified, initialSource),
    'clean',
  )
  await store.commitPendingPublication(pending, pendingSource)
  await store.claimPublicationWrite(pending, owner, pendingSource)
  assert.deepEqual(await store.getPendingPublication(), pending)

  assert.equal(await store.cleanupStalePendingPublication(verified, restoredSource), 'active')
  assert.deepEqual(await store.getPendingPublication(), pending)

  now += 60
  assert.equal(await store.cleanupStalePendingPublication(verified, restoredSource), 'cleaned')
  assert.equal(await store.getPendingPublication(), undefined)
  assert.equal(
    await store.confirmPublicationWrite(pending, owner, pendingSource),
    'conflict',
  )
})

test('publication freshness watermark response loss replays the exact source without regression', async () => {
  const database = new PublicationResponseLossD1()
  const store = new D1StateStore(database)
  const verified: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 9,
    content_hash: '6'.repeat(64),
    r2_key: `snapshots/v1/9-${'6'.repeat(64)}.json`,
    published_at: 600,
  }
  const source = {
    schema_version: 1 as const,
    source_observed_at: 700,
    publication_id: 'workflow-watermark',
    content_hash: verified.content_hash,
  }
  await store.putAppStateIfNewer('public:verified', verified, verified.generation)
  database.loseNextBatchResponse = true

  await assert.rejects(
    store.cleanupStalePendingPublication(verified, source),
    /watermark response loss/,
  )
  assert.equal(await store.cleanupStalePendingPublication(verified, source), 'clean')
  assert.deepEqual(await store.getAppStateUnknown('public:source-watermark'), source)
})

test('sync run lifecycle uses positional binds and persists only classified error codes', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)

  await store.startSyncRun(syncRun({ stage: 'initialize' }))
  await assert.rejects(
    store.startSyncRun(syncRun({ stage: 'initialize', collection_count: 999 })),
    /Sync run instance payload mismatch: run-1/,
  )
  await store.updateSyncRun('run-1', {
    stage: 'collections',
    heartbeat_at: 110,
    collection_count: 551,
    changed_count: 1,
    result_json: '{"schema_version":1,"result":{"runId":"run-1"}}',
  })
  await store.completeSyncRun('run-1', {
    heartbeat_at: 120,
    completed_at: 120,
    input_hash: 'a'.repeat(64),
    public_hash: 'b'.repeat(64),
    result_json: '{"schema_version":1,"result":{"runId":"run-1"}}',
  })
  await store.startSyncRun(syncRun({ instance_id: 'run-2', stage: 'initialize' }))
  await store.failSyncRun('run-2', {
    heartbeat_at: 130,
    completed_at: 130,
    error_code: 'UPSTREAM_RATE_LIMITED',
  })

  const statements = fake.batchCalls.flat()
  assert.equal(statements.length, 6)
  assert.ok(statements.every(({ sql, binds }) => (sql.match(/\?/g) ?? []).length === binds.length))
  assert.match(statements[0]?.sql ?? '', /^INSERT INTO sync_runs \(/)
  assert.match(statements[0]?.sql ?? '', /ON CONFLICT\(instance_id\) DO NOTHING$/)
  assert.match(statements[2]?.sql ?? '', /^UPDATE sync_runs SET stage = \?/)
  assert.match(statements[2]?.sql ?? '', /\bresult_json = \?/)
  assert.match(statements[3]?.sql ?? '', /^UPDATE sync_runs SET status = 'ok'/)
  assert.match(statements[3]?.sql ?? '', /\bresult_json = COALESCE\(\?, result_json\)/)
  assert.match(statements[3]?.sql ?? '', /status NOT IN \('ok', 'error'\)$/)
  assert.match(statements[5]?.sql ?? '', /^UPDATE sync_runs SET status = 'error'/)
  assert.match(statements[5]?.sql ?? '', /status NOT IN \('ok', 'error'\)$/)
  assert.ok(statements[5]?.binds.includes('UPSTREAM_RATE_LIMITED'))
  assert.equal(JSON.stringify(statements).includes('raw body'), false)
})

test('getSyncRun selects the persisted replay result without interpreting its artifact', async () => {
  const fake = new RecordingD1()
  const row = syncRun({
    instance_id: 'prepared',
    stage: 'media',
    result_json: '{"schema_version":1,"result":{"runId":"prepared"}}',
  })
  fake.syncRows.set('prepared', { ...row })

  assert.deepEqual(await new D1StateStore(fake).getSyncRun('prepared'), row)
  assert.match(fake.prepared.at(-1)?.sql ?? '', /\bresult_json\b/)

  fake.syncRows.set('prepared', { ...row, result_json: '{broken' })
  assert.equal((await new D1StateStore(fake).getSyncRun('prepared'))?.result_json, '{broken')
})

test('getSyncRun leaves replay artifact JSON parsing to the lifecycle boundary', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  await store.startSyncRun(syncRun({ instance_id: 'raw-artifact' }))
  fake.syncRows.get('raw-artifact')!.result_json = '{malformed'

  const row = await store.getSyncRun('raw-artifact')

  assert.equal(row?.result_json, '{malformed')
})

test('startSyncRun accepts exact replay but rejects instance id reuse with different payload', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  const initial = syncRun({ instance_id: 'replay', stage: 'initialize', started_at: 100 })
  await store.startSyncRun(initial)
  await store.startSyncRun(initial)
  await assert.rejects(
    store.startSyncRun({ ...initial, stage: 'collections' }),
    /Sync run instance payload mismatch: replay/,
  )
})

test('startSyncRun exact replay is safe after committed response loss', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  const initial = syncRun({ instance_id: 'lost-start', stage: 'initialize' })
  fake.loseStartResponseOnce = true
  await assert.rejects(store.startSyncRun(initial), /start response loss/)
  await store.startSyncRun(initial)
})

test('committed completion survives response loss and catch-path failure', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  await store.startSyncRun(syncRun({ instance_id: 'lost', status: 'running' }))
  fake.loseCompleteResponseOnce = true

  await assert.rejects(
    store.completeSyncRun('lost', { heartbeat_at: 120, completed_at: 120 }),
    /response loss/,
  )
  assert.deepEqual(
    await store.failSyncRun('lost', {
      heartbeat_at: 121,
      completed_at: 121,
      error_code: 'INTERNAL_ERROR',
    }),
    { outcome: 'preserved_opposite_terminal', terminal: 'ok' },
  )

  assert.equal(fake.syncStatuses.get('lost'), 'ok')
})

test('sync lifecycle rejects missing runs and keeps same terminal replay idempotent', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  await assert.rejects(
    store.updateSyncRun('missing', { stage: 'collections', heartbeat_at: 1 }),
    /Sync run not found: missing/,
  )
  await assert.rejects(
    store.completeSyncRun('missing', { heartbeat_at: 1, completed_at: 1 }),
    /Sync run not found: missing/,
  )
  await assert.rejects(
    store.failSyncRun('missing', {
      heartbeat_at: 1,
      completed_at: 1,
      error_code: 'INTERNAL_ERROR',
    }),
    /Sync run not found: missing/,
  )
  await store.startSyncRun(syncRun({ instance_id: 'same' }))
  assert.deepEqual(
    await store.completeSyncRun('same', { heartbeat_at: 2, completed_at: 2 }),
    { outcome: 'applied', terminal: 'ok' },
  )
  assert.deepEqual(
    await store.completeSyncRun('same', { heartbeat_at: 3, completed_at: 3 }),
    { outcome: 'already_same_terminal', terminal: 'ok' },
  )
  assert.equal(fake.syncStatuses.get('same'), 'ok')
})

test('opposite sync terminal transitions preserve the first terminal result explicitly', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)

  await store.startSyncRun(syncRun({ instance_id: 'failed-first' }))
  assert.deepEqual(
    await store.failSyncRun('failed-first', {
      heartbeat_at: 2,
      completed_at: 2,
      error_code: 'UPSTREAM_ERROR',
    }),
    { outcome: 'applied', terminal: 'error' },
  )
  assert.deepEqual(
    await store.completeSyncRun('failed-first', { heartbeat_at: 3, completed_at: 3 }),
    { outcome: 'preserved_opposite_terminal', terminal: 'error' },
  )

  await store.startSyncRun(syncRun({ instance_id: 'ok-first' }))
  await store.completeSyncRun('ok-first', { heartbeat_at: 4, completed_at: 4 })
  assert.deepEqual(
    await store.failSyncRun('ok-first', {
      heartbeat_at: 5,
      completed_at: 5,
      error_code: 'INTERNAL_ERROR',
    }),
    { outcome: 'preserved_opposite_terminal', terminal: 'ok' },
  )
})

test('updateSyncRun never binds explicit undefined optional values', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  await store.startSyncRun(syncRun())
  await store.updateSyncRun('run-1', {
    stage: 'collections',
    heartbeat_at: 110,
    generation: undefined,
    input_hash: undefined,
    collection_count: 0,
  })
  const statement = fake.batchCalls[1]?.[0]
  assert.equal(statement?.binds.includes(undefined), false)
  assert.doesNotMatch(statement?.sql ?? '', /generation|input_hash/)
  assert.match(statement?.sql ?? '', /collection_count = \?/)
})

test('batch result validation rejects missing or unsuccessful D1 results', async () => {
  class InvalidResultD1 extends RecordingD1 {
    override async batch<T = Record<string, unknown>>(): Promise<D1ResultLike<T>[]> {
      return []
    }
  }
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.updates = [collection({ state_version: 2, changed_at: 200, content_hash: 'b'.repeat(64) })]
  await assert.rejects(
    new D1StateStore(new InvalidResultD1()).applyCollectionDiff(plan),
    /D1 batch result cardinality mismatch/,
  )

  class FailedResultD1 extends RecordingD1 {
    override async batch<T = Record<string, unknown>>(): Promise<D1ResultLike<T>[]> {
      return [{ ...result<T>(), success: false } as unknown as D1ResultLike<T>]
    }
  }
  await assert.rejects(
    new D1StateStore(new FailedResultD1()).applyCollectionDiff(plan),
    /Invalid D1 batch result/,
  )
})

test('sync lifecycle and app-state writes share strict D1 batch result validation', async () => {
  class InvalidWriteResultD1 extends RecordingD1 {
    override async batch<T = Record<string, unknown>>(): Promise<D1ResultLike<T>[]> {
      return []
    }
  }
  const store = new D1StateStore(new InvalidWriteResultD1())
  await assert.rejects(store.startSyncRun(syncRun()), /D1 batch result cardinality mismatch/)
  await assert.rejects(store.putAppState('x', { ok: true }), /D1 batch result cardinality mismatch/)
})

test('failSyncRun rejects raw bodies, comments and stack-like text before preparing SQL', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  for (const unsafe of [
    'upstream said: raw body',
    '401 Unauthorized\n<html>secret</html>',
    'Error: failed\n    at worker.ts:10:2',
    'user comment here',
  ]) {
    await assert.rejects(
      store.failSyncRun('run', { heartbeat_at: 1, completed_at: 1, error_code: unsafe }),
      /classified error code/,
    )
  }
  assert.equal(fake.prepared.length, 0)
  assert.equal(fake.batchCalls.length, 0)
})
