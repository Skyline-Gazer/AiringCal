import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson, type PublicSnapshotPointerV1 } from '@airing-cal/storage'
import {
  promoteShadowPointer,
  type PublicationPointerKv,
} from './r2-publication.ts'

class MemoryKv implements PublicationPointerKv {
  values = new Map<string, string>()
  currentPuts = 0

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async put(key: string, value: string): Promise<void> {
    if (key === 'public:current') this.currentPuts++
    this.values.set(key, value)
  }
}

function pointer(generation: number): PublicSnapshotPointerV1 {
  const hash = 'c'.repeat(64)
  return {
    schema_version: 1,
    generation,
    content_hash: hash,
    r2_key: `snapshots/v1/${generation}-${hash}.json`,
    published_at: 1_000,
  }
}

test('no shadow pointer is not promoted', async () => {
  const kv = new MemoryKv()

  const result = await promoteShadowPointer(kv, 1_234)

  assert.deepEqual(result, { promoted: false, generation: 0 })
  assert.equal(kv.values.has('public:current'), false)
})

test('a valid shadow pointer is promoted to public:current with a read-mode mirror', async () => {
  const kv = new MemoryKv()
  kv.values.set('public:shadow-current', canonicalJson(pointer(9)))

  const result = await promoteShadowPointer(kv, 1_234)

  assert.deepEqual(result, { promoted: true, generation: 9 })
  assert.equal(kv.values.get('public:current'), canonicalJson(pointer(9)))
  const mirror = JSON.parse(kv.values.get('public:read-mode') ?? '{}')
  assert.equal(mirror.mode, 'r2')
  assert.equal(mirror.switched_at, 1_234)
})

test('an invalid shadow pointer is not promoted', async () => {
  const kv = new MemoryKv()
  kv.values.set('public:shadow-current', '{"schema_version":99}')

  const result = await promoteShadowPointer(kv, 1_234)

  assert.deepEqual(result, { promoted: false, generation: 0 })
  assert.equal(kv.values.has('public:current'), false)
})

test('promoting the already-current pointer is idempotent without rewriting', async () => {
  const kv = new MemoryKv()
  const bytes = canonicalJson(pointer(9))
  kv.values.set('public:shadow-current', bytes)
  kv.values.set('public:current', bytes)

  const result = await promoteShadowPointer(kv, 1_234)

  assert.deepEqual(result, { promoted: true, generation: 9 })
  assert.equal(kv.currentPuts, 0)
  assert.equal(kv.values.get('public:current'), bytes)
})
