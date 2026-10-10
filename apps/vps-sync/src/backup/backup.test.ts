import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup, createProductionBackup } from './backup.ts'

test('creates a custom dump then uploads dump before its canonical manifest', async () => {
  const events: string[] = []
  const files = new Map<string, Uint8Array>()
  const backup = createBackup({
    databaseUrl: 'postgres://user:secret@db.example:5432/airing?sslmode=require',
    gitSha: 'a'.repeat(40),
    now: () => Date.parse('2026-09-09T12:34:56.000Z'),
    command: async (command, args, environment) => {
      events.push(`command:${command}:${args.join(' ')}`)
      assert.equal(command, 'pg_dump')
      assert.ok(args.includes('--format=custom'))
      assert.ok(!args.some((arg) => arg.includes('postgres://')))
      assert.equal(environment.PGHOST, 'db.example')
      assert.equal(environment.PGDATABASE, 'airing')
      assert.equal(environment.PGSSLMODE, 'require')
      assert.equal(environment.PGOPTIONS, undefined)
      const output = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
      assert.ok(output)
      files.set(output, new TextEncoder().encode('custom-dump'))
    },
    files: {
      makeDirectory: async () => '/tmp/airing-cal/backup-1',
      read: async (path) => files.get(path) ?? new Uint8Array(),
      remove: async (path) => { events.push(`remove:${path}`) },
    },
    s3: { put: async (key, bytes) => { events.push(`put:${key}:${new TextDecoder().decode(bytes)}`) } },
  })

  const result = await backup({ runId: 'run-1' })

  assert.deepEqual(events.slice(0, 3), [
    'command:pg_dump:--format=custom --file=/tmp/airing-cal/backup-1/backup.dump',
    'put:backups/postgres/2026/09/09/2026-09-09T12-34-56-000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dump:custom-dump',
    'put:backups/postgres/2026/09/09/2026-09-09T12-34-56-000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json:{"created_at":"2026-09-09T12:34:56.000Z","git_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","object_key":"backups/postgres/2026/09/09/2026-09-09T12-34-56-000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dump","run_id":"run-1","schema_version":1,"sha256":"04023b9631b41a84e8c4cb1404349dd89b98763d7686969c11289d25472f1571","size":11}',
  ])
  assert.equal(result.size, 11)
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.ok(events.some((event) => event.startsWith('remove:/tmp/airing-cal/backup-1')))
})

test('rejects backup URLs with unsupported connection parameters', async () => {
  const backup = createBackup({
    databaseUrl: 'postgres://user:secret@db.example/airing?application_name=unsafe', gitSha: 'c'.repeat(40), now: () => 0,
    command: async () => { throw new Error('must not run') },
    files: { makeDirectory: async () => '/tmp/airing-cal/backup-3', read: async () => new Uint8Array(), remove: async () => undefined },
    s3: { put: async () => undefined },
  })

  await assert.rejects(() => backup({ runId: 'run-3' }), { message: 'BACKUP_DATABASE_URL_INVALID' })
})

test('rejects duplicate or empty sslmode connection parameters', async () => {
  for (const suffix of ['sslmode=require&sslmode=require', 'sslmode=']) {
    const backup = createBackup({
      databaseUrl: `postgres://user:secret@db.example/airing?${suffix}`, gitSha: 'e'.repeat(40), now: () => 0,
      command: async () => { throw new Error('must not run') },
      files: { makeDirectory: async () => '/tmp/airing-cal/backup-5', read: async () => new Uint8Array(), remove: async () => undefined },
      s3: { put: async () => undefined },
    })
    await assert.rejects(() => backup({ runId: 'run-5' }), { message: 'BACKUP_DATABASE_URL_INVALID' })
  }
})

test('does not copy host PostgreSQL connection defaults into pg_dump', async () => {
  const previous = process.env.PGOPTIONS
  process.env.PGOPTIONS = '--host-override'
  try {
    const backup = createBackup({
      databaseUrl: 'postgres://user:secret@db.example/airing?sslmode=require', gitSha: 'd'.repeat(40), now: () => 0,
      command: async (_command, _args, environment) => {
        assert.equal(environment.PGOPTIONS, undefined)
        assert.equal(environment.PGSSLMODE, 'require')
      },
      files: { makeDirectory: async () => '/tmp/airing-cal/backup-4', read: async () => new Uint8Array(), remove: async () => undefined },
      s3: { put: async () => undefined },
    })
    await backup({ runId: 'run-4' })
  } finally {
    if (previous === undefined) delete process.env.PGOPTIONS
    else process.env.PGOPTIONS = previous
  }
})

test('production pg_dump clears inherited PG variables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'airing-cal-backup-test-'))
  const command = join(directory, 'pg_dump')
  const captured = join(directory, 'environment.json')
  const oldPath = process.env.PATH
  const previous = Object.fromEntries(['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGOPTIONS', 'PGSSLMODE', 'PGSERVICE', 'PGAIRING_TEST'].map((key) => [key, process.env[key]]))
  try {
    await writeFile(command, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.env))\nwriteFileSync(process.argv.find((arg) => arg.startsWith('--file=')).slice(7), 'dump')\n`)
    await chmod(command, 0o755)
    process.env.PATH = `${directory}:${oldPath}`
    process.env.CAPTURE_FILE = captured
    for (const key of Object.keys(previous)) process.env[key] = `inherited-${key}`

    const backup = createProductionBackup({
      databaseUrl: 'postgres://user:secret@db.example:5433/airing?sslmode=require', gitSha: 'f'.repeat(40), now: () => 0,
      s3: { put: async () => undefined },
    })
    await backup({ runId: 'run-6' })
    const environment = JSON.parse(await readFile(captured, 'utf8')) as Record<string, string>
    assert.deepEqual(Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith('PG'))), {
      PGHOST: 'db.example', PGPORT: '5433', PGUSER: 'user', PGPASSWORD: 'secret', PGDATABASE: 'airing', PGSSLMODE: 'require',
    })
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    delete process.env.CAPTURE_FILE
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('cleans the temporary directory if pg_dump fails', async () => {
  const events: string[] = []
  const backup = createBackup({
    databaseUrl: 'postgres://user:secret@db.example/airing', gitSha: 'b'.repeat(40), now: () => 0,
    command: async (_command, args) => { events.push('command'); throw new Error(`upload target ${args.join(' ')}`) },
    files: { makeDirectory: async () => '/tmp/airing-cal/backup-2', read: async () => new Uint8Array(), remove: async (path) => { events.push(`remove:${path}`) } },
    s3: { put: async () => undefined },
  })
  await assert.rejects(() => backup({ runId: 'run-2' }))
  assert.deepEqual(events, ['command', 'remove:/tmp/airing-cal/backup-2'])
})
