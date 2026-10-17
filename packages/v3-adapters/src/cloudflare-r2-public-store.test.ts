import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicReleasePointer } from '@airing-cal/v3-core/ports'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
import { CloudflareR2PublicStore } from './cloudflare-r2-public-store.ts'
import { MemoryR2Bucket } from './memory-r2-binding.ts'

function samplePointer(generation: number): PublicReleasePointer {
  return {
    schema_version: 1,
    generation,
    content_hash: `hash-${generation}`,
    published_at_unix: 1_700_000_000 + generation,
    artifact_ref: `snapshots/v1/${generation}-hash-${generation}.json`,
  }
}

test('CloudflareR2PublicStore enforces immutable objects and pointer CAS', async () => {
  const bucket = new MemoryR2Bucket()
  const store = new CloudflareR2PublicStore(bucket)
  const body = new TextEncoder().encode('{"schema_version":1}')
  await store.putImmutableObject('snapshots/v1/1-a.json', body, 'application/json')
  await store.putImmutableObject('snapshots/v1/1-a.json', body, 'application/json')
  const changed = new TextEncoder().encode('{"schema_version":2}')
  await assert.rejects(
    () => store.putImmutableObject('snapshots/v1/1-a.json', changed, 'application/json'),
    /different bytes/,
  )

  const first = samplePointer(1)
  assert.equal(await store.commitRelease(null, first), 'committed')
  assert.equal(await store.commitRelease(null, first), 'conflict')
  const second = samplePointer(2)
  assert.equal(await store.commitRelease(first, second), 'committed')
  assert.deepEqual(await store.getCurrentRelease(), second)
})

test('commitRelease refuses a head() result without a usable quoted httpEtag', async () => {
  const bucket = new MemoryR2Bucket()
  await bucket.put(PUBLIC_RELEASE_POINTER_KEY, `${JSON.stringify(samplePointer(1))}\n`)
  const store = new CloudflareR2PublicStore({
    get: (key) => bucket.get(key),
    head: async (key) => {
      const result = await bucket.head(key)
      return result ? { ...result, httpEtag: '' } : null
    },
    put: (key, value, options) => bucket.put(key, value, options),
  })
  await assert.rejects(
    () => store.commitRelease(samplePointer(1), samplePointer(2)),
    /httpEtag/,
  )
})
