import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicReleasePointer } from '@airing-cal/v3-core/ports'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
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
