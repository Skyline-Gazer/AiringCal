import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import type {
  CollectionDiffPlanLike,
  CollectionRow,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
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

test('getSyncRun selects and validates the persisted replay result', async () => {
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
  await assert.rejects(new D1StateStore(fake).getSyncRun('prepared'), /Invalid sync_runs\.result_json/)
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
