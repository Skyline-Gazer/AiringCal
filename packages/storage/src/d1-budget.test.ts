import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from './d1-types.ts'
import {
  markBudgetSubmission,
  reserveDailyBudget,
  type BudgetReservationRequest,
} from './d1-budget.ts'

const currentUtcDate = new Date().toISOString().slice(0, 10)

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
    const statement = this.database.prepare(this.sql)
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return result<T>(0, statement.all(...this.binds as SQLInputValue[]) as T[])
    }
    const applied = statement.run(...this.binds as SQLInputValue[])
    return result<T>(Number(applied.changes))
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    return result<T>(0, this.database.prepare(this.sql).all(...this.binds as SQLInputValue[]) as T[])
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.database.prepare(this.sql).all(...this.binds as SQLInputValue[]).map((row) => Object.values(row) as T)
  }
}

class TransactionalSqliteD1 implements D1DatabaseLike {
  private readonly database = new DatabaseSync(':memory:')
  private tail: Promise<void> = Promise.resolve()
  readonly batchCardinalities: number[] = []

  constructor() {
    this.database.exec(`
      CREATE TABLE sync_budget (
        date TEXT NOT NULL,
        resource TEXT NOT NULL CHECK (resource IN ('media')),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
        consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (date, resource)
      );
      CREATE TABLE sync_budget_reservations (
        reservation_id TEXT NOT NULL PRIMARY KEY,
        date TEXT NOT NULL,
        resource TEXT NOT NULL CHECK (resource IN ('media')),
        request_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        submission_status TEXT NOT NULL CHECK (submission_status IN ('reserved', 'submitted', 'uncertain')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteStatement(sql, this.database)
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results: D1ResultLike<T>[] = []
      for (const statement of statements) results.push(await statement.run<T>())
      this.database.exec('COMMIT')
      this.batchCardinalities.push(results.length)
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.database.exec(sql)
    return { count: 0, duration: 0 }
  }

  budget(date: string) {
    const row = this.database.prepare(
      'SELECT reserved, consumed FROM sync_budget WHERE date = ? AND resource = ?',
    ).get(date, 'media') as { reserved: number; consumed: number } | undefined
    return row ? { reserved: row.reserved, consumed: row.consumed } : undefined
  }
}

function request(
  reservationId: string,
  jobs: number,
  privilegedCount = jobs,
): BudgetReservationRequest {
  return {
    date: currentUtcDate,
    resource: 'media',
    reservationId,
    jobs: Array.from({ length: jobs }, (_, subject_id) => ({ subject_id, components: ['detail'] })),
    privilegedCount,
    softLimit: 50,
    hardLimit: 100,
  }
}

test('two concurrent reservations grant the final hard-limit slot only once', async () => {
  const database = new TransactionalSqliteD1()
  assert.equal((await reserveDailyBudget(database, request('seed', 99))).granted, 99)

  const results = await Promise.all([
    reserveDailyBudget(database, request('last-a', 1)),
    reserveDailyBudget(database, request('last-b', 1)),
  ])

  assert.deepEqual(results.map(({ granted }) => granted).sort(), [0, 1])
  assert.deepEqual(database.budget(currentUtcDate), { reserved: 100, consumed: 0 })
})

test('same reservation returns a byte-equivalent stored result without consuming twice', async () => {
  const database = new TransactionalSqliteD1()
  const original = request('stable', 40, 0)
  const first = await reserveDailyBudget(database, original)
  const replay = await reserveDailyBudget(database, structuredClone(original))

  assert.equal(JSON.stringify(replay), JSON.stringify(first))
  assert.deepEqual(database.budget(currentUtcDate), { reserved: 40, consumed: 0 })
})

test('first claim charges the authoritative current UTC day while preserving request date fingerprint', async () => {
  const database = new TransactionalSqliteD1()
  const dayTwoNow = Date.UTC(2026, 6, 28, 0, 0, 1) / 1_000
  await reserveDailyBudget(database, {
    ...request('day-two-full', 100, 100),
    date: '2026-07-28',
  }, dayTwoNow)

  const stalePending = { ...request('stale-pending', 1, 1), date: '2026-07-27' }
  const first = await reserveDailyBudget(database, stalePending, dayTwoNow)
  const replay = await reserveDailyBudget(database, structuredClone(stalePending), dayTwoNow + 60)

  assert.equal(first.granted, 0)
  assert.equal(JSON.stringify(replay), JSON.stringify(first))
  assert.equal(database.budget('2026-07-27'), undefined)
  assert.deepEqual(database.budget('2026-07-28'), { reserved: 100, consumed: 0 })
})

test('same reservation ID with changed jobs rejects the fingerprint mismatch', async () => {
  const database = new TransactionalSqliteD1()
  await reserveDailyBudget(database, request('changed', 1))
  await assert.rejects(
    reserveDailyBudget(database, {
      ...request('changed', 1),
      jobs: [{ subject_id: 999, components: ['image_common'] }],
    }),
    /reservation payload mismatch/,
  )
  assert.deepEqual(database.budget(currentUtcDate), { reserved: 1, consumed: 0 })
})

test('reservation fingerprint distinguishes D1-only V4 from legacy-compatible V3', async () => {
  const database = new TransactionalSqliteD1()
  const original = {
    ...request('media-version', 1),
    jobs: [{
      version: 4,
      generation: { observed_at: 7, run_id: 'run' },
      job_id: 'run:1',
      subject_id: 1,
      title: 'A',
      components: ['detail'],
    }],
  }
  await reserveDailyBudget(database, original)
  await assert.rejects(
    reserveDailyBudget(database, {
      ...original,
      jobs: [{
        ...original.jobs[0]!,
        version: 3,
        generation: 7,
      }],
    }),
    /reservation payload mismatch/,
  )
  await assert.rejects(
    reserveDailyBudget(database, {
      ...original,
      jobs: [{
        ...original.jobs[0]!,
        generation: { observed_at: 8, run_id: 'run' },
      }],
    }),
    /reservation payload mismatch/,
  )
  assert.deepEqual(database.budget(currentUtcDate), { reserved: 1, consumed: 0 })
})

test('soft headroom is ordinary-only while privileged work can reach hard limit', async () => {
  const database = new TransactionalSqliteD1()
  assert.equal((await reserveDailyBudget(database, request('ordinary', 80, 0))).granted, 50)
  assert.equal((await reserveDailyBudget(database, request('privileged', 60, 60))).granted, 50)
  assert.equal((await reserveDailyBudget(database, request('exhausted', 1, 1))).granted, 0)
  assert.deepEqual(database.budget(currentUtcDate), { reserved: 100, consumed: 0 })
})

test('submission transition atomically moves occupied capacity from reserved to consumed', async () => {
  const database = new TransactionalSqliteD1()
  const reserved = await reserveDailyBudget(database, request('submit', 3))
  assert.equal(reserved.submission, 'reserved')

  const uncertain = await markBudgetSubmission(database, 'submit', 'uncertain', 1_000)
  const replay = await markBudgetSubmission(database, 'submit', 'uncertain', 1_001)

  assert.equal(uncertain.submission, 'uncertain')
  assert.equal(JSON.stringify(replay), JSON.stringify(uncertain))
  assert.deepEqual(database.budget(currentUtcDate), { reserved: 0, consumed: 3 })
})

test('budget adapter rejects malformed D1 result cardinality and metadata', async () => {
  const malformedCardinality = new TransactionalSqliteD1()
  malformedCardinality.batch = async () => []
  await assert.rejects(reserveDailyBudget(malformedCardinality, request('cardinality', 1)), /cardinality/)

  const malformedMeta = new TransactionalSqliteD1()
  malformedMeta.batch = async (statements) => statements.map(() => ({
    ...result(),
    meta: { ...result().meta, changes: -1 },
  }))
  await assert.rejects(reserveDailyBudget(malformedMeta, request('meta', 1)), /metadata/)
})
