import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CollectionDiffPlanLike,
  CollectionRow,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  SyncRunRow,
} from './d1-types.ts'
import { D1StateStore } from './d1-state-store.ts'

interface RecordedStatement {
  sql: string
  binds: unknown[]
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
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.binds = values
    return this
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
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
  readonly syncStatuses = new Map<string, string>()
  nextChanges: number[] = []
  throwBeforeBatchAt: number | null = null
  loseCollectionResponseAt: number | null = null
  loseCompleteResponseOnce = false
  private batchIndex = 0

  prepare(sql: string): D1PreparedStatementLike {
    const statement = new RecordingStatement(sql, this.rows)
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
      }
      if (changes === undefined && sql.startsWith('INSERT INTO sync_runs')) {
        const instanceId = String(binds[0])
        changes = this.syncStatuses.has(instanceId) ? 0 : 1
        if (changes === 1) this.syncStatuses.set(instanceId, String(binds[1]))
      }
      if (changes === undefined && sql.startsWith("UPDATE sync_runs SET status = 'ok'")) {
        const instanceId = String(binds.at(-1))
        const status = this.syncStatuses.get(instanceId)
        const guarded = sql.includes("status NOT IN ('ok', 'error')")
        changes = guarded && (status === 'ok' || status === 'error') ? 0 : 1
        if (changes === 1) this.syncStatuses.set(instanceId, 'ok')
      }
      if (changes === undefined && sql.startsWith("UPDATE sync_runs SET status = 'error'")) {
        const instanceId = String(binds.at(-1))
        const status = this.syncStatuses.get(instanceId)
        const guarded = sql.includes("status NOT IN ('ok', 'error')")
        changes = guarded && (status === 'ok' || status === 'error') ? 0 : 1
        if (changes === 1) this.syncStatuses.set(instanceId, 'error')
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
  plan.updates = [collection({ rate: 9, content_hash: 'b'.repeat(64), changed_at: 200 })]

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
  assert.match(fake.batchCalls[0]?.[0]?.sql ?? '', /ON CONFLICT\(user_id, subject_id\) DO NOTHING$/)

  fake.throwBeforeBatchAt = null
  const replay = await new D1StateStore(fake).applyCollectionDiff(plan)
  assert.equal(replay.rowsWritten, 71)
  assert.equal(fake.insertedCollections.size, 121)
})

test('applyCollectionDiff maps every transition to correct SQL and binds in stable order', async () => {
  const fake = new RecordingD1()
  const plan: CollectionDiffPlanLike = {
    inserts: [collection({ user_id: 'zoe', subject_id: 9 })],
    updates: [collection({ user_id: 'bob', subject_id: 8, rate: 9 })],
    unchanged: 7,
    firstMissing: [collection({ user_id: 'alice', subject_id: 7, missing_since: 200 })],
    confirmedDeleted: [collection({ user_id: 'alice', subject_id: 6, missing_since: 100, deleted_at: 200 })],
    restored: [collection({ user_id: 'alice', subject_id: 5, missing_since: null, deleted_at: null })],
  }

  const result = await new D1StateStore(fake).applyCollectionDiff(plan)
  const statements = fake.batchCalls.flat()

  assert.equal(result.rowsWritten, 5)
  assert.equal(statements.length, 5)
  assert.deepEqual(statements.map(({ sql, binds }) => {
    if (sql.startsWith('INSERT')) return binds.slice(0, 2)
    if (sql.startsWith('UPDATE collection_items SET deleted_at')) return binds.slice(1, 3)
    if (sql.includes('(missing_since IS NOT NULL')) return binds.slice(-3, -1)
    if (sql.includes('changed_at <')) return binds.slice(-3, -1)
    return binds.slice(-2)
  }), [
    ['alice', 5],
    ['alice', 6],
    ['alice', 7],
    ['bob', 8],
    ['zoe', 9],
  ])
  assert.match(statements[0]?.sql ?? '', /^UPDATE collection_items SET collection_type = \?/)
  assert.match(statements[1]?.sql ?? '', /^UPDATE collection_items SET deleted_at = \?/)
  assert.deepEqual(statements[1]?.binds, [200, 'alice', 6, 100])
  assert.match(statements[1]?.sql ?? '', /missing_since = \? AND deleted_at IS NULL$/)
  assert.match(statements[2]?.sql ?? '', /^UPDATE collection_items SET missing_since = \?/)
  assert.deepEqual(statements[2]?.binds, [200, 'alice', 7])
  assert.match(statements[2]?.sql ?? '', /missing_since IS NULL AND deleted_at IS NULL$/)
  assert.match(statements[3]?.sql ?? '', /^UPDATE collection_items SET collection_type = \?/)
  assert.match(statements[4]?.sql ?? '', /^INSERT INTO collection_items \(/)
})

test('collection CAS ignores stale missing, deletion and restore transitions and counts actual changes', async () => {
  const fake = new RecordingD1()
  fake.nextChanges = [0, 0, 0]
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.firstMissing = [collection({ subject_id: 1, missing_since: 200 })]
  plan.confirmedDeleted = [collection({ subject_id: 2, missing_since: 100, deleted_at: 200 })]
  plan.restored = [collection({ subject_id: 3, changed_at: 150 })]

  const applied = await new D1StateStore(fake).applyCollectionDiff(plan)

  assert.equal(applied.rowsWritten, 0)
  const statements = fake.batchCalls.flat()
  assert.match(statements[0]?.sql ?? '', /missing_since IS NULL AND deleted_at IS NULL$/)
  assert.match(statements[1]?.sql ?? '', /missing_since = \? AND deleted_at IS NULL$/)
  assert.match(statements[2]?.sql ?? '', /changed_at <= \?.*\(missing_since IS NOT NULL OR deleted_at IS NOT NULL\)$/)
})

test('business updates require a strictly newer changed_at against delayed overwrite and replay', async () => {
  const fake = new RecordingD1()
  fake.nextChanges = [0]
  const plan = emptyPlan()
  plan.unchanged = 0
  plan.updates = [collection({ changed_at: 200, content_hash: 'b'.repeat(64) })]

  assert.equal((await new D1StateStore(fake).applyCollectionDiff(plan)).rowsWritten, 0)
  const statement = fake.batchCalls[0]?.[0]
  assert.match(statement?.sql ?? '', /changed_at < \? AND missing_since IS NULL AND deleted_at IS NULL$/)
  assert.deepEqual(statement?.binds.slice(-3), ['alice', 23080, 200])
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
  assert.deepEqual(await store.getAppState('public:pending'), { a: 1, z: 2 })
})

test('app_state rejects unknown versions and corrupt JSON', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)
  fake.rows = [{ value_json: '{"schema_version":2,"value":{}}' }]
  await assert.rejects(store.getAppState('x'), /Unsupported app_state schema_version/)
  fake.rows = [{ value_json: '{broken' }]
  await assert.rejects(store.getAppState('x'), /Invalid app_state JSON/)
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
  await store.startSyncRun(syncRun({ stage: 'initialize', collection_count: 999 }))
  await store.updateSyncRun('run-1', {
    stage: 'collections',
    heartbeat_at: 110,
    collection_count: 551,
    changed_count: 1,
  })
  await store.completeSyncRun('run-1', {
    heartbeat_at: 120,
    completed_at: 120,
    input_hash: 'a'.repeat(64),
    public_hash: 'b'.repeat(64),
  })
  await store.failSyncRun('run-2', {
    heartbeat_at: 130,
    completed_at: 130,
    error_code: 'UPSTREAM_RATE_LIMITED',
  })

  const statements = fake.batchCalls.flat()
  assert.equal(statements.length, 5)
  assert.ok(statements.every(({ sql, binds }) => (sql.match(/\?/g) ?? []).length === binds.length))
  assert.match(statements[0]?.sql ?? '', /^INSERT INTO sync_runs \(/)
  assert.match(statements[0]?.sql ?? '', /ON CONFLICT\(instance_id\) DO NOTHING$/)
  assert.match(statements[2]?.sql ?? '', /^UPDATE sync_runs SET stage = \?/)
  assert.match(statements[3]?.sql ?? '', /^UPDATE sync_runs SET status = 'ok'/)
  assert.match(statements[3]?.sql ?? '', /status NOT IN \('ok', 'error'\)$/)
  assert.match(statements[4]?.sql ?? '', /^UPDATE sync_runs SET status = 'error'/)
  assert.match(statements[4]?.sql ?? '', /status NOT IN \('ok', 'error'\)$/)
  assert.ok(statements[4]?.binds.includes('UPSTREAM_RATE_LIMITED'))
  assert.equal(JSON.stringify(statements).includes('raw body'), false)
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
  await store.failSyncRun('lost', {
    heartbeat_at: 121,
    completed_at: 121,
    error_code: 'INTERNAL_ERROR',
  })

  assert.equal(fake.syncStatuses.get('lost'), 'ok')
})

test('updateSyncRun never binds explicit undefined optional values', async () => {
  const fake = new RecordingD1()
  await new D1StateStore(fake).updateSyncRun('run-1', {
    stage: 'collections',
    heartbeat_at: 110,
    generation: undefined,
    input_hash: undefined,
    collection_count: 0,
  })
  const statement = fake.batchCalls[0]?.[0]
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
  plan.updates = [collection({ changed_at: 200, content_hash: 'b'.repeat(64) })]
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
