import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackup } from './backup.ts'

test('creates a custom dump then uploads dump before its canonical manifest', async () => {
  const events: string[] = []
  const files = new Map<string, Uint8Array>()
  const backup = createBackup({
    databaseUrl: 'postgres://user:secret@db.example:5432/airing',
    gitSha: 'a'.repeat(40),
    now: () => Date.parse('2026-09-09T12:34:56.000Z'),
    command: async (command, args, environment) => {
      events.push(`command:${command}:${args.join(' ')}`)
      assert.equal(command, 'pg_dump')
      assert.ok(args.includes('--format=custom'))
      assert.ok(!args.some((arg) => arg.includes('postgres://')))
      assert.equal(environment.PGHOST, 'db.example')
      assert.equal(environment.PGDATABASE, 'airing')
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
