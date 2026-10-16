import { DatabaseSync } from 'node:sqlite'
import { BUILDER_SCHEMA_VERSION, MIGRATION_STATEMENTS } from './schema.ts'

export function applyBuilderSchema(db: DatabaseSync, nowIso = new Date().toISOString()): void {
  db.exec('BEGIN')
  try {
    for (const statement of MIGRATION_STATEMENTS) {
      db.exec(statement)
    }
    db.prepare(
      'INSERT INTO v3_schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING',
    ).run(BUILDER_SCHEMA_VERSION, nowIso)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function openBuilderDatabase(path: ':memory:' | string = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path)
  applyBuilderSchema(db)
  return db
}

export function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}
