import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openBuilderDatabase, SyncRunStore } from '@airing-cal/v3-builder'
import { MemoryObjectStore } from '../adapters/memory-object-store.ts'
import { DEFAULT_CHECKPOINT_OBJECT_KEY } from '../adapters/s3-checkpoint-store.ts'
import {
  resolveWriterSyncMode,
  runGhaPortableWriter,
} from './gha-portable-writer.ts'

test('resolveWriterSyncMode uses full every N days from last successful full', () => {
  const now = 1_700_000_000
  assert.equal(resolveWriterSyncMode(now, 7, null), 'full')
  assert.equal(resolveWriterSyncMode(now, 7, now - 7 * 86_400), 'full')
  assert.equal(resolveWriterSyncMode(now, 7, now - 6 * 86_400), 'incremental')
})

test('runGhaPortableWriter honors explicit AIRINGCAL_BUILDER_MODE override', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gha-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const objects = new MemoryObjectStore()
  const syncCalls: Array<Record<string, string | undefined>> = []
  try {
    const result = await runGhaPortableWriter({
      env: {
        AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
        AIRINGCAL_BUILDER_MODE: 'full',
        AIRINGCAL_BUILDER_OWNER: 'gha-test',
      },
      nowUnix: 1_700_000_000,
      checkpointStore: objects,
      runSync: async (env) => {
        syncCalls.push({ ...env })
        writeFileSync(sqlitePath, 'x')
        return { job: 'airingcal-sync', status: 'success', message: 'ok' }
      },
      notifyFailure: async () => {},
    })
    assert.equal(result.status, 'success')
    assert.equal(result.mode, 'full')
    assert.equal(syncCalls[0].AIRINGCAL_BUILDER_MODE, 'full')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runGhaPortableWriter restores checkpoint, sets mode, uploads on success, skips Bark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gha-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const objects = new MemoryObjectStore()
  // Seed a prior successful full run in a sqlite that we upload as checkpoint.
  {
    const seedPath = join(dir, 'seed.sqlite')
    const db = openBuilderDatabase(seedPath)
    const runs = new SyncRunStore(db)
    runs.startRun('seed-full', 'full', 1_000)
    runs.finishRun('seed-full', 'succeeded', null, 1_700_000_000 - 3 * 86_400)
    db.close()
    await objects.put(DEFAULT_CHECKPOINT_OBJECT_KEY, new Uint8Array(readFileSync(seedPath)))
  }

  const barkCalls: unknown[] = []
  const syncCalls: Array<Record<string, string | undefined>> = []

  try {
    const result = await runGhaPortableWriter({
      env: {
        AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
        AIRINGCAL_FULL_EVERY_DAYS: '7',
        AIRINGCAL_BUILDER_OWNER: 'gha-test',
      },
      nowUnix: 1_700_000_000,
      checkpointStore: objects,
      runSync: async (env) => {
        syncCalls.push({ ...env })
        writeFileSync(sqlitePath, 'updated-sqlite')
        return { job: 'airingcal-sync', status: 'success', message: 'ok' }
      },
      notifyFailure: async (_env, payload) => {
        barkCalls.push(payload)
      },
    })

    assert.equal(result.status, 'success')
    assert.equal(result.mode, 'incremental')
    assert.equal(syncCalls.length, 1)
    assert.equal(syncCalls[0].AIRINGCAL_BUILDER_MODE, 'incremental')
    assert.equal(syncCalls[0].AIRINGCAL_BUILDER, 'portable')
    assert.equal(barkCalls.length, 0)
    assert.equal(
      new TextDecoder().decode((await objects.get(DEFAULT_CHECKPOINT_OBJECT_KEY))!.body),
      'updated-sqlite',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runGhaPortableWriter fails closed on lease held and notifies Bark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gha-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const objects = new MemoryObjectStore()
  await objects.put(
    'checkpoints/lease.json',
    new TextEncoder().encode(JSON.stringify({
      owner_token: 'other',
      expires_at_unix: 9_999_999_999,
    }) + '\n'),
  )

  const barkCalls: Array<{ title: string; body: string }> = []
  try {
    const result = await runGhaPortableWriter({
      env: {
        AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
        BARK_URL: 'https://api.day.app/PLACEHOLDER_BARK_KEY',
      },
      nowUnix: 1_700_000_000,
      checkpointStore: objects,
      runSync: async () => {
        throw new Error('should not run')
      },
      notifyFailure: async (_env, payload) => {
        barkCalls.push(payload)
      },
    })
    assert.equal(result.status, 'failed')
    assert.match(result.message, /lease held/i)
    assert.equal(barkCalls.length, 1)
    assert.equal(existsSync(sqlitePath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runGhaPortableWriter notifies Bark when sync fails and still releases lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gha-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const objects = new MemoryObjectStore()
  const barkCalls: Array<{ title: string; body: string }> = []

  try {
    const result = await runGhaPortableWriter({
      env: {
        AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
        AIRINGCAL_BUILDER_OWNER: 'gha-test',
        BARK_URL: 'https://api.day.app/key',
      },
      nowUnix: 1_700_000_000,
      checkpointStore: objects,
      runSync: async () => ({ job: 'airingcal-sync', status: 'failed', message: 'boom' }),
      notifyFailure: async (_env, payload) => {
        barkCalls.push(payload)
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(barkCalls.length, 1)
    assert.match(barkCalls[0].body, /boom/)
    // Lease released so another owner can acquire.
    const again = await runGhaPortableWriter({
      env: {
        AIRINGCAL_BUILDER_SQLITE_PATH: join(dir, 'builder2.sqlite'),
        AIRINGCAL_BUILDER_OWNER: 'gha-test-2',
      },
      nowUnix: 1_700_000_100,
      checkpointStore: objects,
      runSync: async () => ({ job: 'airingcal-sync', status: 'success', message: 'ok' }),
      notifyFailure: async () => {},
    })
    assert.equal(again.status, 'success')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
