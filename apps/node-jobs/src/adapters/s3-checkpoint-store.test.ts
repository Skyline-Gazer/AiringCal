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
  renewCheckpointLease,
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

test('uploadCheckpointFromFile enforces checkpoint CAS (C4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-ckpt-cas-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const store = new MemoryObjectStore()
  try {
    writeFileSync(sqlitePath, 'sqlite-v1')
    const first = await uploadCheckpointFromFile(store, sqlitePath)
    assert.equal(first.status, 'uploaded')
    assert.ok(first.etag)

    // First-create CAS: a concurrent create without a prior etag must fail.
    writeFileSync(sqlitePath, 'sqlite-v2')
    const conflict = await uploadCheckpointFromFile(store, sqlitePath)
    assert.equal(conflict.status, 'precondition_failed')

    // Uploading against the observed prior etag succeeds.
    const ok = await uploadCheckpointFromFile(store, sqlitePath, undefined, { priorEtag: first.etag })
    assert.equal(ok.status, 'uploaded')

    // Stale etag cannot overwrite a newer checkpoint.
    await store.put(DEFAULT_CHECKPOINT_OBJECT_KEY, new TextEncoder().encode('sqlite-newer'), {
      contentType: 'application/octet-stream',
    })
    writeFileSync(sqlitePath, 'sqlite-v3')
    const stale = await uploadCheckpointFromFile(store, sqlitePath, undefined, { priorEtag: ok.etag })
    assert.equal(stale.status, 'precondition_failed')
    assert.equal(
      new TextDecoder().decode((await store.get(DEFAULT_CHECKPOINT_OBJECT_KEY))!.body),
      'sqlite-newer',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renewCheckpointLease requires an owned, unexpired lease (C4)', async () => {
  const store = new MemoryObjectStore()
  await acquireCheckpointLease(store, { ownerToken: 'a', nowUnix: 1_000, ttlSeconds: 60 })

  const renewed = await renewCheckpointLease(store, { ownerToken: 'a', nowUnix: 1_030, ttlSeconds: 60 })
  assert.equal(renewed.status, 'renewed')
  const lease = JSON.parse(new TextDecoder().decode((await store.get(DEFAULT_CHECKPOINT_LEASE_KEY))!.body)) as {
    owner_token: string
    expires_at_unix: number
  }
  assert.equal(lease.owner_token, 'a')
  assert.equal(lease.expires_at_unix, 1_090)

  const foreign = await renewCheckpointLease(store, { ownerToken: 'b', nowUnix: 1_031, ttlSeconds: 60 })
  assert.equal(foreign.status, 'lost')

  const expired = await renewCheckpointLease(store, { ownerToken: 'a', nowUnix: 1_091, ttlSeconds: 60 })
  assert.equal(expired.status, 'lost')

  await store.delete(DEFAULT_CHECKPOINT_LEASE_KEY)
  const missing = await renewCheckpointLease(store, { ownerToken: 'a', nowUnix: 1_092, ttlSeconds: 60 })
  assert.equal(missing.status, 'lost')
})

test('releaseCheckpointLease expires via ifMatch put and never deletes (C4)', async () => {
  const store = new MemoryObjectStore()
  await acquireCheckpointLease(store, { ownerToken: 'a', nowUnix: 1_000, ttlSeconds: 60 })
  await releaseCheckpointLease(store, 'a')

  const released = await store.get(DEFAULT_CHECKPOINT_LEASE_KEY)
  assert.ok(released, 'lease object must not be deleted on release')
  const releasedLease = JSON.parse(new TextDecoder().decode(released.body)) as {
    owner_token: string
    expires_at_unix: number
  }
  assert.equal(releasedLease.owner_token, '')
  assert.equal(releasedLease.expires_at_unix, 0)

  await acquireCheckpointLease(store, { ownerToken: 'b', nowUnix: 1_001, ttlSeconds: 60 })
  await releaseCheckpointLease(store, 'not-owner')
  const after = JSON.parse(new TextDecoder().decode((await store.get(DEFAULT_CHECKPOINT_LEASE_KEY))!.body)) as {
    owner_token: string
  }
  assert.equal(after.owner_token, 'b', 'release by a non-owner is a no-op')
})
