import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryObjectStore } from './memory-object-store.ts'
import {
  DEFAULT_CHECKPOINT_OBJECT_KEY,
  DEFAULT_CHECKPOINT_LEASE_KEY,
  restoreCheckpointToFile,
  uploadCheckpointFromFile,
  acquireCheckpointLease,
  releaseCheckpointLease,
} from './s3-checkpoint-store.ts'

test('restoreCheckpointToFile returns missing when object absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-ckpt-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const store = new MemoryObjectStore()
  try {
    const result = await restoreCheckpointToFile(store, sqlitePath)
    assert.deepEqual(result, { status: 'missing' })
    assert.equal(existsSync(sqlitePath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('upload then restore round-trips sqlite bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-ckpt-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const restoredPath = join(dir, 'restored.sqlite')
  const store = new MemoryObjectStore()
  writeFileSync(sqlitePath, 'sqlite-bytes-v1')
  try {
    const uploaded = await uploadCheckpointFromFile(store, sqlitePath)
    assert.equal(uploaded.status, 'uploaded')
    assert.equal(uploaded.key, DEFAULT_CHECKPOINT_OBJECT_KEY)
    assert.ok(uploaded.etag)

    const restored = await restoreCheckpointToFile(store, restoredPath)
    assert.equal(restored.status, 'restored')
    assert.equal(readFileSync(restoredPath, 'utf8'), 'sqlite-bytes-v1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('acquireCheckpointLease fences concurrent owners', async () => {
  const store = new MemoryObjectStore()
  const first = await acquireCheckpointLease(store, {
    ownerToken: 'runner-a',
    nowUnix: 1_000,
    ttlSeconds: 60,
  })
  assert.equal(first.status, 'acquired')
  assert.equal(first.key, DEFAULT_CHECKPOINT_LEASE_KEY)

  const blocked = await acquireCheckpointLease(store, {
    ownerToken: 'runner-b',
    nowUnix: 1_010,
    ttlSeconds: 60,
  })
  assert.equal(blocked.status, 'held')
  assert.equal(blocked.holder, 'runner-a')

  const afterExpiry = await acquireCheckpointLease(store, {
    ownerToken: 'runner-b',
    nowUnix: 1_061,
    ttlSeconds: 60,
  })
  assert.equal(afterExpiry.status, 'acquired')

  await releaseCheckpointLease(store, 'runner-b')
  const again = await acquireCheckpointLease(store, {
    ownerToken: 'runner-a',
    nowUnix: 1_100,
    ttlSeconds: 60,
  })
  assert.equal(again.status, 'acquired')
})
