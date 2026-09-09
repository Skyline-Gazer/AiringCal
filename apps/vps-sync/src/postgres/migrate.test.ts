import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { applyMigrations, withSessionLock } from './migrate.ts'
import * as migrationModule from './migrate.ts'

type Migration = { name: string; checksum: string }

class FakeDatabase {
  migrations = new Map<string, string>()
  migrationTableExists = true
  migrationSql: string[] = []
  readonly heldLocks = new Set<string>()
  readonly statements: string[] = []
  readonly failures = new Map<string, Error>()
}

class FakeClient {
  released = false

  constructor(private readonly database: FakeDatabase) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[] }> {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    this.database.statements.push(normalized)
    for (const [needle, error] of this.database.failures) {
      if (normalized.includes(needle)) throw error
    }

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

    if (sql.includes('to_regclass')) {
      return {
        rows: [{
          migration_table: this.database.migrationTableExists ? 'schema_migrations' : null,
        } as unknown as Row],
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

async function checksum(name: string): Promise<string> {
  const contents = await readFile(new URL(`./migrations/${name}`, import.meta.url))
  return createHash('sha256').update(contents).digest('hex')
}

async function assertCurrentSchema(pool: FakePool): Promise<void> {
  const candidate = migrationModule as typeof migrationModule & {
    assertCurrentSchema(pool: never): Promise<void>
  }
  await candidate.assertCurrentSchema(asPool(pool))
}

test('applies migrations in filename order and leaves a repeated run unchanged', async () => {
  const pool = new FakePool()

  await applyMigrations(asPool(pool))

  const applied = [...pool.database.migrations.entries()]
    .map(([name, checksum]) => ({ name, checksum }))
  assert.deepEqual(applied.map((migration) => migration.name), [
    '0001_initial.sql',
    '0002_authority_constraints.sql',
    '0003_publication_modes.sql',
  ])
  assert.match(applied[0]?.checksum ?? '', /^[a-f0-9]{64}$/)
  assert.equal(pool.database.migrationSql.length, 1)
  assert.equal(pool.clients.every((client) => client.released), true)

  const migrationSqlCount = pool.database.migrationSql.length
  await applyMigrations(asPool(pool))
  assert.equal(pool.database.migrationSql.length, migrationSqlCount)
})

test('acquires the migration advisory lock before bootstrap DDL', async () => {
  const pool = new FakePool()

  await applyMigrations(asPool(pool))

  const lockIndex = pool.database.statements.findIndex((sql) => sql.includes('pg_try_advisory_lock'))
  const bootstrapIndex = pool.database.statements.findIndex((sql) => sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations'))
  assert.ok(lockIndex >= 0)
  assert.ok(bootstrapIndex > lockIndex)
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

test('accepts only an ordered applied prefix before applying the remaining migration tail', async () => {
  const pool = new FakePool()
  pool.database.migrations.set('0001_initial.sql', await checksum('0001_initial.sql'))

  await applyMigrations(asPool(pool))
  assert.deepEqual([...pool.database.migrations.keys()], [
    '0001_initial.sql',
    '0002_authority_constraints.sql',
    '0003_publication_modes.sql',
  ])
  await assertCurrentSchema(pool)
})

test('rejects a non-prefix migration history instead of backfilling an earlier gap', async () => {
  const pool = new FakePool()
  pool.database.migrations.set(
    '0002_authority_constraints.sql',
    await checksum('0002_authority_constraints.sql'),
  )

  await assert.rejects(
    () => applyMigrations(asPool(pool)),
    /MIGRATION_HISTORY_GAP/,
  )
  assert.equal(pool.database.migrations.has('0001_initial.sql'), false)
})

test('current-schema gate rejects a behind schema without applying migrations', async () => {
  const pool = new FakePool()
  pool.database.migrations.set('0001_initial.sql', await checksum('0001_initial.sql'))

  await assert.rejects(
    () => assertCurrentSchema(pool),
    /MIGRATION_SCHEMA_BEHIND/,
  )
  assert.deepEqual([...pool.database.migrations.keys()], ['0001_initial.sql'])
  assert.equal(pool.clients.every((client) => client.released), true)
})

test('current-schema gate rejects an empty database without a migration table', async () => {
  const pool = new FakePool()
  pool.database.migrationTableExists = false

  await assert.rejects(
    () => assertCurrentSchema(pool),
    /MIGRATION_SCHEMA_BEHIND/,
  )
  assert.equal(pool.clients.every((client) => client.released), true)
})

test('current-schema gate rejects an ahead schema', async () => {
  const pool = new FakePool()
  pool.database.migrations.set('0001_initial.sql', await checksum('0001_initial.sql'))
  pool.database.migrations.set('0002_authority_constraints.sql', await checksum('0002_authority_constraints.sql'))
  pool.database.migrations.set('9999_future.sql', 'a'.repeat(64))

  await assert.rejects(
    () => assertCurrentSchema(pool),
    /MIGRATION_SCHEMA_AHEAD/,
  )
  assert.equal(pool.clients.every((client) => client.released), true)
})

test('preserves a migration failure when rollback also fails and always releases the client', async () => {
  const pool = new FakePool()
  pool.database.failures.set('CREATE TABLE users', new Error('migration write failed'))
  pool.database.failures.set('ROLLBACK', new Error('rollback also failed'))

  await assert.rejects(
    () => applyMigrations(asPool(pool)),
    /migration write failed/,
  )
  assert.equal(pool.clients.every((client) => client.released), true)
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

test('keeps the published 0001 migration byte-for-byte immutable and moves authority fences to 0002', async () => {
  const original = await readFile(new URL('./migrations/0001_initial.sql', import.meta.url))
  const authorityConstraints = await readFile(new URL('./migrations/0002_authority_constraints.sql', import.meta.url), 'utf8')

  assert.equal(
    createHash('sha256').update(original).digest('hex'),
    'cd06c6a655aee9762095de384407e584a2340ad9b7a5a17b027adb966337486f',
  )
  assert.match(authorityConstraints, /ADD COLUMN missing_run_id uuid REFERENCES sync_runs\(id\)/)
  assert.match(authorityConstraints, /ADD COLUMN observed_run_id uuid REFERENCES sync_runs\(id\)/)
})

test('uses a dedicated build config that excludes every test file from production emit', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>
  }
  const buildConfig = JSON.parse(await readFile(new URL('../../tsconfig.build.json', import.meta.url), 'utf8')) as {
    exclude?: string[]
  }

  assert.match(packageJson.scripts.build, /tsc -p tsconfig\.build\.json/)
  assert.doesNotMatch(packageJson.scripts.build, /rm .*\.test\.js/)
  assert.deepEqual(buildConfig.exclude, ['src/**/*.test.ts'])
})

test('declares a separate fail-closed database integration command', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>
  }

  assert.equal(
    packageJson.scripts['test:integration'],
    'tsx --test src/postgres/postgres.integration.test.ts',
  )
  assert.match(packageJson.scripts.test, /--test-skip-pattern=PostgreSQL/)
})
