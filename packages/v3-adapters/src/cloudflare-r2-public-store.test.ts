import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicReleasePointer } from '@airing-cal/v3-core/ports'
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
