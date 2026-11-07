import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicReleasePointer } from '@airing-cal/v3-core/ports'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
import type { ConditionalObjectStore } from './object-store.ts'
import { MemoryObjectStore } from './memory-object-store.ts'
import { S3CompatiblePublicStore } from './s3-public-store.ts'

function samplePointer(generation: number): PublicReleasePointer {
  return {
    schema_version: 1,
    generation,
    content_hash: `hash-${generation}`,
    published_at_unix: 1_700_000_000 + generation,
    artifact_ref: `snapshots/v1/${generation}-hash-${generation}.json`,
  }
}

test('S3CompatiblePublicStore enforces immutable objects and pointer CAS', async () => {
  const objects = new MemoryObjectStore()
  const store = new S3CompatiblePublicStore(objects)
  const body = new TextEncoder().encode('{"schema_version":1}')
  await store.putImmutableObject('snapshots/v1/1-a.json', body, 'application/json')
  await store.putImmutableObject('snapshots/v1/1-a.json', body, 'application/json')
  await assert.rejects(
    () => store.putImmutableObject('snapshots/v1/1-a.json', new TextEncoder().encode('x'), 'application/json'),
    /different bytes/,
  )

  const first = samplePointer(1)
  assert.equal(await store.commitRelease(null, first), 'committed')
  assert.equal(await store.commitRelease(null, first), 'conflict')
  const second = samplePointer(2)
  assert.equal(await store.commitRelease(first, second), 'committed')
  assert.deepEqual(await store.getCurrentRelease(), second)
  assert.equal(store.pointerKey, PUBLIC_RELEASE_POINTER_KEY)
})

test('S3CompatiblePublicStore sets immutable cache headers for image content types', async () => {
  const objects = new MemoryObjectStore()
  const puts: Array<{ key: string; options: Record<string, unknown> }> = []
  const recording: ConditionalObjectStore = {
    get: (key) => objects.get(key),
    head: (key) => objects.head(key),
    list: (prefix) => objects.list(prefix),
    delete: (key) => objects.delete(key),
    async put(key, body, options = {}) {
      puts.push({ key, options: { ...options } })
      return objects.put(key, body, options)
    },
  }
  const store = new S3CompatiblePublicStore(recording)
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
  await store.putImmutableObject('images/aa/original', jpeg, 'image/jpeg')
  assert.equal(puts.length, 1)
  assert.equal(puts[0]?.options.contentType, 'image/jpeg')
  assert.equal(puts[0]?.options.cacheControl, 'public, max-age=31536000, immutable')
  assert.equal(puts[0]?.options.contentDisposition, 'inline')

  puts.length = 0
  const json = new TextEncoder().encode('{"ok":true}')
  await store.putImmutableObject('snapshots/v1/1-a.json', json, 'application/json')
  assert.equal(puts.length, 1)
  assert.equal(puts[0]?.options.contentType, 'application/json')
  assert.equal(puts[0]?.options.cacheControl, undefined)
  assert.equal(puts[0]?.options.contentDisposition, undefined)
})
