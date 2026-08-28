import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Pool, PoolClient } from 'pg'

// Verified 2026-08-28: pg 8.23.0 with @types/pg 8.23.1 exposes
// Pool.connect(): Promise<PoolClient> and parameterized PoolClient.query(...).
const MIGRATION_LOCK_KEY = 7_021_825_048_668_725_931n
const migrationsUrl = new URL('./migrations/', import.meta.url)
const migrationFileName = /^\d{4}_[a-z0-9_]+\.sql$/

type Migration = {
  name: string
  checksum: string
  sql: string
}

type AppliedMigration = {
  name: string
  checksum: string
}

export async function withSessionLock<T>(
  client: PoolClient,
  key: bigint,
  work: () => Promise<T>,
): Promise<{ acquired: boolean; value?: T }> {
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [key.toString()],
  )
  if (!result.rows[0]?.acquired) return { acquired: false }

  try {
    return { acquired: true, value: await work() }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [key.toString()])
  }
}

export async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const lock = await withSessionLock(client, MIGRATION_LOCK_KEY, async () => {
      const [migrations, appliedResult] = await Promise.all([
        loadMigrations(),
        client.query<AppliedMigration>('SELECT name, checksum FROM schema_migrations ORDER BY name'),
      ])
      const migrationsByName = new Map(migrations.map((migration) => [migration.name, migration]))

      for (const applied of appliedResult.rows) {
        const migration = migrationsByName.get(applied.name)
        if (!migration) {
          throw new Error(`MIGRATION_SCHEMA_AHEAD: ${applied.name} is not supported by this application`)
        }
        if (migration.checksum !== applied.checksum) {
          throw new Error(`MIGRATION_CHECKSUM_MISMATCH: ${migration.name}`)
        }
      }

      const appliedNames = new Set(appliedResult.rows.map((migration) => migration.name))
      for (const migration of migrations) {
        if (appliedNames.has(migration.name)) continue
        await applyMigration(client, migration)
      }
    })

    if (!lock.acquired) throw new Error('MIGRATION_LOCK_UNAVAILABLE')
  } finally {
    client.release()
  }
}

async function loadMigrations(): Promise<Migration[]> {
  const directory = fileURLToPath(migrationsUrl)
  const names = (await readdir(directory))
    .filter((name) => migrationFileName.test(name))
    .sort((left, right) => left.localeCompare(right))

  return Promise.all(names.map(async (name) => {
    const sql = await readFile(new URL(name, migrationsUrl), 'utf8')
    return {
      name,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    }
  }))
}

async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query(
      'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
      [migration.name, migration.checksum],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
