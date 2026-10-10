import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPublicSnapshot } from '@airing-cal/domain'
import type { PublicSnapshotPointerV1, PublicSnapshotV1 } from '@airing-cal/storage'
import {
  loadVerifiedSnapshot,
  readSnapshotSource,
  validatePointer,
  type ReadSnapshotCache,
  type ReadSnapshotDataR2,
  type ReadSnapshotKv,
} from './r2-snapshot.ts'

const hash = 'c'.repeat(64)

function pointer(generation = 9): PublicSnapshotPointerV1 {
  return {
    schema_version: 1,
    generation,
    content_hash: hash,
    r2_key: `snapshots/v1/${generation}-${hash}.json`,
    published_at: 1_000,
  }
}

async function fixture(generation = 9): Promise<{ pointer: PublicSnapshotPointerV1; snapshot: PublicSnapshotV1 }> {
  const snapshot = await buildPublicSnapshot({
    collections: [],
    calendar: [],
    published_at: 1_000,
  }, generation)
  const pointer: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation,
    content_hash: snapshot.content_hash,
    r2_key: `snapshots/v1/${generation}-${snapshot.content_hash}.json`,
    published_at: 1_000,
  }
  return { pointer, snapshot }
}

class FakeKv implements ReadSnapshotKv {
  values = new Map<string, unknown>()

  async get(key: string, _type: 'json'): Promise<unknown> {
    return this.values.get(key) ?? null
  }
}

class FakeR2 implements ReadSnapshotDataR2 {
  objects = new Map<string, string>()
  failGet = false

  async get(key: string): Promise<{ key: string; text(): Promise<string> } | null> {
    if (this.failGet) throw new Error('injected R2 GET failure')
    const value = this.objects.get(key)
    return value === undefined ? null : { key, async text() { return value } }
  }
}

class FakeCache implements ReadSnapshotCache {
  values = new Map<string, Response>()

  async match(request: Request): Promise<Response | undefined> {
    return this.values.get(request.url)
  }

  async put(request: Request, response: Response): Promise<void> {
    this.values.set(request.url, response)
  }
}

test('validatePointer accepts a canonical pointer and rejects invalid ones', () => {
  assert.deepEqual(validatePointer(pointer()), pointer())
  assert.equal(validatePointer({ ...pointer(), schema_version: 2 }), null)
  assert.equal(validatePointer({ ...pointer(), content_hash: 'xyz' }), null)
  assert.equal(validatePointer({ ...pointer(), r2_key: 'snapshots/v1/9-wrong.json' }), null)
  assert.equal(validatePointer(null), null)
})

test('loadVerifiedSnapshot reads and validates the R2 object and warms the cache', async () => {
  const { pointer: pointerValue, snapshot: snapshotValue } = await fixture()
  const r2 = new FakeR2()
  r2.objects.set(pointerValue.r2_key, JSON.stringify(snapshotValue))
  const cache = new FakeCache()

  const loaded = await loadVerifiedSnapshot(r2, cache, pointerValue)

  assert.equal(loaded?.fromCache, false)
  assert.equal(loaded?.snapshot.generation, 9)
  assert.equal(cache.values.size, 1)
})

test('loadVerifiedSnapshot falls back to the last verified cache when R2 fails', async () => {
  const { pointer: pointerValue, snapshot: snapshotValue } = await fixture()
  const r2 = new FakeR2()
  r2.failGet = true
  const cache = new FakeCache()
  await cache.put(
    new Request(`https://cache.local/r2-snapshot/${pointerValue.content_hash}`),
    new Response(JSON.stringify(snapshotValue), { headers: { 'content-type': 'application/json' } }),
  )

  const loaded = await loadVerifiedSnapshot(r2, cache, pointerValue)

  assert.equal(loaded?.fromCache, true)
  assert.equal(loaded?.snapshot.generation, 9)
})

test('loadVerifiedSnapshot returns null when R2 and cache are both unavailable', async () => {
  const loaded = await loadVerifiedSnapshot(new FakeR2(), new FakeCache(), pointer())
  assert.equal(loaded, null)
})

test('loadVerifiedSnapshot rejects an R2 object whose generation does not match the pointer', async () => {
  const { pointer: pointerValue } = await fixture(9)
  const { snapshot: otherSnapshot } = await fixture(10)
  const r2 = new FakeR2()
  r2.objects.set(pointerValue.r2_key, JSON.stringify(otherSnapshot))
  const loaded = await loadVerifiedSnapshot(r2, new FakeCache(), pointerValue)
  assert.equal(loaded, null)
})

test('readSnapshotSource stays legacy without an r2 read mode', async () => {
  const kv = new FakeKv()
  kv.values.set('public:current', pointer())
  const source = await readSnapshotSource(kv, new FakeR2(), new FakeCache())
  assert.deepEqual(source, { mode: 'legacy' })
})

test('readSnapshotSource serves the verified R2 snapshot when read mode is r2', async () => {
  const { pointer: pointerValue, snapshot: snapshotValue } = await fixture()
  const kv = new FakeKv()
  kv.values.set('public:read-mode', { mode: 'r2', switched_at: 1_234 })
  kv.values.set('public:current', pointerValue)
  const r2 = new FakeR2()
  r2.objects.set(pointerValue.r2_key, JSON.stringify(snapshotValue))

  const source = await readSnapshotSource(kv, r2, new FakeCache())

  assert.equal(source.mode, 'r2')
  if (source.mode === 'r2') assert.equal(source.snapshot.generation, 9)
})

test('readSnapshotSource falls back to legacy when the pointer is invalid in r2 mode', async () => {
  const kv = new FakeKv()
  kv.values.set('public:read-mode', { mode: 'r2', switched_at: 1_234 })
  kv.values.set('public:current', { schema_version: 99 })
  const source = await readSnapshotSource(kv, new FakeR2(), new FakeCache())
  assert.deepEqual(source, { mode: 'legacy' })
})
