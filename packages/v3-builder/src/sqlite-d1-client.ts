import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export type SqliteD1Row = Record<string, unknown>

/** Minimal D1-shaped client for reusing node-jobs media SQL against builder SQLite. */
export interface BuilderSqliteD1Client {
  query(sql: string, params?: SQLInputValue[]): Promise<SqliteD1Row[]>
}

export function createBuilderSqliteD1Client(db: DatabaseSync): BuilderSqliteD1Client {
  return {
    async query(sql, params: SQLInputValue[] = []) {
      const statement = db.prepare(sql)
      const upper = sql.trimStart().toUpperCase()
      if (upper.startsWith('SELECT')) {
        return statement.all(...params) as SqliteD1Row[]
      }
      statement.run(...params)
      return []
    },
  }
}
