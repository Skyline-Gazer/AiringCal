import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { restoreVerify } from './restore.ts'

const sha = 'a'.repeat(40)
const key = `backups/postgres/2026/09/10/2026-09-10T00-00-00-000Z-${sha}.dump`
const dump = new TextEncoder().encode('custom-dump')
const manifest = new TextEncoder().encode(JSON.stringify({
  schema_version: 1, run_id: 'run-1', git_sha: sha, created_at: '2026-09-10T00:00:00.000Z',
  object_key: key, size: dump.byteLength, sha256: createHash('sha256').update(dump).digest('hex'),
}))

function dependencies(overrides: Partial<Parameters<typeof restoreVerify>[0]> = {}) {
  const events: string[] = []
  return {
    events,
    deps: {
      productionDatabaseUrl: 'postgres://user:secret@prod.example:5432/airing?sslmode=require',
      targetDatabaseUrl: 'postgresql://restore:secret@restore.example/airing_restore',
      s3: { get: async (objectKey: string) => objectKey === key ? dump : objectKey === key.replace(/\.dump$/, '.json') ? manifest : null },
      files: { makeDirectory: async () => '/tmp/restore-1', write: async (path: string) => { events.push(`write:${path}`) }, remove: async (path: string) => { events.push(`remove:${path}`) } },
      database: { isEmpty: async () => true, close: async () => { events.push('close') } },
      command: async (command: string, args: readonly string[]) => { events.push(`${command}:${args.join(' ')}`) },
      verify: async () => ({ schemaVersion: 3, rowCounts: { users: 1 }, snapshotHash: 'b'.repeat(64) }),
      ...overrides,
    },
  }
}

test('downloads a checksummed backup, restores only an empty non-production target, and verifies recovery', async () => {
  const { deps, events } = dependencies()
  const report = await restoreVerify(deps, key)
  assert.deepEqual(report, { schemaVersion: 3, rowCounts: { users: 1 }, snapshotHash: 'b'.repeat(64) })
  assert.ok(events.some((event) => event.startsWith('pg_restore:--exit-on-error --no-owner --no-privileges --format=c ')))
  assert.ok(events.includes('remove:/tmp/restore-1'))
})

test('rejects a normalized production target or a non-empty target before pg_restore', async () => {
  for (const overrides of [
    { targetDatabaseUrl: 'POSTGRES://user:secret@PROD.example/airing?sslmode=require' },
    { database: { isEmpty: async () => false, close: async () => undefined } },
  ]) {
    const { deps, events } = dependencies(overrides)
    await assert.rejects(() => restoreVerify(deps, key), /RESTORE_TARGET_(PRODUCTION|NOT_EMPTY)/)
    assert.equal(events.some((event) => event.startsWith('pg_restore:')), false)
  }
})

test('closes the target connection when a safety gate rejects restore', async () => {
  const { deps, events } = dependencies({ targetDatabaseUrl: 'postgres://user:secret@prod.example/airing' })
  await assert.rejects(() => restoreVerify(deps, key), /RESTORE_TARGET_PRODUCTION/)
  assert.ok(events.includes('close'))
})

test('rejects an invalid key or checksum mismatch before pg_restore', async () => {
  const invalid = dependencies()
  await assert.rejects(() => restoreVerify(invalid.deps, 'backups/postgres/unsafe.dump'), /RESTORE_BACKUP_KEY_INVALID/)
  assert.equal(invalid.events.some((event) => event.startsWith('pg_restore:')), false)

  const mismatch = dependencies({ s3: { get: async (objectKey: string) => objectKey === key ? new Uint8Array([1]) : manifest } })
  await assert.rejects(() => restoreVerify(mismatch.deps, key), /RESTORE_CHECKSUM_MISMATCH/)
  assert.equal(mismatch.events.some((event) => event.startsWith('pg_restore:')), false)
})
