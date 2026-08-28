import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMigrations, withSessionLock } from './migrate.ts'

type Migration = { name: string; checksum: string }

class FakeDatabase {
  migrations = new Map<string, string>()
  migrationSql: string[] = []
  readonly heldLocks = new Set<string>()
}

class FakeClient {
  released = false

  constructor(private readonly database: FakeDatabase) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[] }> {
    if (sql.includes('pg_try_advisory_lock')) {
      const key = String(values[0])
      const acquired = !this.database.heldLocks.has(key)
      if (acquired) this.database.heldLocks.add(key)
      return { rows: [{ acquired } as unknown as Row] }
    }

    if (sql.includes('pg_advisory_unlock')) {
      this.database.heldLocks.delete(String(values[0]))
      return { rows: [{ released: true } as unknown as Row] }
    }

    if (sql.includes('SELECT name, checksum FROM schema_migrations')) {
      return {
        rows: [...this.database.migrations.entries()]
          .map(([name, checksum]) => ({ name, checksum }) as unknown as Row),
      }
    }

    if (sql.includes('INSERT INTO schema_migrations')) {
      this.database.migrations.set(String(values[0]), String(values[1]))
      return { rows: [] }
    }

    if (sql.includes('CREATE TABLE') && !sql.includes('schema_migrations')) {
      this.database.migrationSql.push(sql)
    }
    return { rows: [] }
  }

  release(): void {
    this.released = true
  }
}

class FakePool {
  readonly database = new FakeDatabase()
  readonly clients: FakeClient[] = []

  async connect(): Promise<FakeClient> {
    const client = new FakeClient(this.database)
    this.clients.push(client)
    return client
  }
}

function asPool(pool: FakePool) {
  return pool as never
}

function asClient(client: FakeClient) {
  return client as never
}

test('applies migrations in filename order and leaves a repeated run unchanged', async () => {
  const pool = new FakePool()

  await applyMigrations(asPool(pool))

  const applied = [...pool.database.migrations.entries()]
    .map(([name, checksum]) => ({ name, checksum }))
  assert.deepEqual(applied.map((migration) => migration.name), ['0001_initial.sql'])
  assert.match(applied[0]?.checksum ?? '', /^[a-f0-9]{64}$/)
  assert.equal(pool.database.migrationSql.length, 1)
  assert.equal(pool.clients.every((client) => client.released), true)

  const migrationSqlCount = pool.database.migrationSql.length
  await applyMigrations(asPool(pool))
  assert.equal(pool.database.migrationSql.length, migrationSqlCount)
})

test('rejects a changed checksum for an applied migration', async () => {
  const pool = new FakePool()
  pool.database.migrations.set('0001_initial.sql', 'f'.repeat(64))

  await assert.rejects(
    () => applyMigrations(asPool(pool)),
    /MIGRATION_CHECKSUM_MISMATCH/,
  )
})

test('rejects a database schema newer than this application supports', async () => {
  const pool = new FakePool()
  pool.database.migrations.set('9999_future.sql', 'a'.repeat(64))

  await assert.rejects(
    () => applyMigrations(asPool(pool)),
    /MIGRATION_SCHEMA_AHEAD/,
  )
})

test('only one session obtains the same advisory lock', async () => {
  const database = new FakeDatabase()
  const a = new FakeClient(database)
  const b = new FakeClient(database)
  let releaseFirst!: () => void
  const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve })

  const first = withSessionLock(asClient(a), 91n, async () => {
    await firstCanFinish
    return 'first'
  })
  await new Promise((resolve) => setImmediate(resolve))
  const second = await withSessionLock(asClient(b), 91n, async () => 'second')
  releaseFirst()
  const firstResult = await first

  assert.deepEqual([firstResult.acquired, second.acquired].sort(), [false, true])
  assert.equal(firstResult.value, 'first')
  assert.equal(second.value, undefined)
  assert.equal(database.heldLocks.size, 0)
})
