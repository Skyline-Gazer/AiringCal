import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from '../d1-types.ts'

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

export class TransactionalBudgetD1 implements D1DatabaseLike {
  private readonly database = new DatabaseSync(':memory:')
  private tail: Promise<void> = Promise.resolve()

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

  budget(date: string): { reserved: number; consumed: number } | undefined {
    const row = this.database.prepare(
      'SELECT reserved, consumed FROM sync_budget WHERE date = ? AND resource = ?',
    ).get(date, 'media') as { reserved: number; consumed: number } | undefined
    return row ? { reserved: row.reserved, consumed: row.consumed } : undefined
  }
}
