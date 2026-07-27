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
    return { results: [], success: true }
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return { results: this.rows as T[], success: true }
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return []
  }
}

class RecordingD1 implements D1DatabaseLike {
  readonly prepared: RecordingStatement[] = []
  readonly batchCalls: RecordedStatement[][] = []
  rows: Record<string, unknown>[] = []

  prepare(sql: string): D1PreparedStatementLike {
    const statement = new RecordingStatement(sql, this.rows)
    this.prepared.push(statement)
    return statement
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    this.batchCalls.push(statements.map((statement) => {
      const recorded = statement as RecordingStatement
      return { sql: recorded.sql, binds: recorded.binds }
    }))
    return statements.map(() => ({ results: [], success: true }))
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
  assert.deepEqual(fake.batchCalls[0]?.[0]?.binds.slice(-2), ['alice', 23080])
  assert.doesNotMatch(fake.batchCalls[0]?.[0]?.sql ?? '', /last_seen/i)
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
  assert.deepEqual(statements.map(({ sql, binds }) =>
    sql.startsWith('INSERT') ? binds.slice(0, 2) : binds.slice(-2)), [
    ['alice', 5],
    ['alice', 6],
    ['alice', 7],
    ['bob', 8],
    ['zoe', 9],
  ])
  assert.match(statements[0]?.sql ?? '', /^UPDATE collection_items SET collection_type = \?/)
  assert.match(statements[1]?.sql ?? '', /^UPDATE collection_items SET deleted_at = \?/)
  assert.deepEqual(statements[1]?.binds, [200, 'alice', 6])
  assert.match(statements[2]?.sql ?? '', /^UPDATE collection_items SET missing_since = \?/)
  assert.deepEqual(statements[2]?.binds, [200, 'alice', 7])
  assert.match(statements[3]?.sql ?? '', /^UPDATE collection_items SET collection_type = \?/)
  assert.match(statements[4]?.sql ?? '', /^INSERT INTO collection_items \(/)
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

test('sync run lifecycle uses positional binds and persists only classified error codes', async () => {
  const fake = new RecordingD1()
  const store = new D1StateStore(fake)

  await store.startSyncRun(syncRun({ stage: 'initialize' }))
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
  assert.equal(statements.length, 4)
  assert.ok(statements.every(({ sql, binds }) => (sql.match(/\?/g) ?? []).length === binds.length))
  assert.match(statements[0]?.sql ?? '', /^INSERT INTO sync_runs \(/)
  assert.match(statements[1]?.sql ?? '', /^UPDATE sync_runs SET stage = \?/)
  assert.match(statements[2]?.sql ?? '', /^UPDATE sync_runs SET status = 'ok'/)
  assert.match(statements[3]?.sql ?? '', /^UPDATE sync_runs SET status = 'error'/)
  assert.ok(statements[3]?.binds.includes('UPSTREAM_RATE_LIMITED'))
  assert.equal(JSON.stringify(statements).includes('raw body'), false)
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
