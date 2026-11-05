import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicReleasePointer } from '@airing-cal/v3-core/ports'
import { HttpPublicStore } from './http-public-store.ts'

function pointer(generation: number): PublicReleasePointer {
  return {
    schema_version: 1,
    generation,
    content_hash: `hash-${generation}`,
    published_at_unix: 1_700_000_000 + generation,
    artifact_ref: `snapshots/v1/${generation}-hash-${generation}.json`,
    manifest_ref: `public/manifests/${generation}-manifest.json`,
  }
}

/** Builds a fake `fetch` over a static public object table and records every call. */
function fetchOver(objects: Record<string, string | Uint8Array>, statusForMissing = 404) {
  const calls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const path = decodeURIComponent(new URL(url).pathname.slice(1))
    const value = objects[path]
    if (value === undefined) return new Response('Not found', { status: statusForMissing })
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    return new Response(new Uint8Array(bytes), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('HttpPublicStore reads pointers and objects from the public base URL', async () => {
  const objects: Record<string, string | Uint8Array> = {
    'public/current-release.json': `${JSON.stringify(pointer(3))}\n`,
    'snapshots/v1/3-hash-3.json': '{"schema_version":1}',
  }
  const { impl, calls } = fetchOver(objects)
  const store = new HttpPublicStore('https://cdn.example.com', undefined, { fetch: impl })

  const release = await store.getCurrentRelease()
  assert.deepEqual(release, pointer(3))
  const snapshot = await store.getSnapshotBytes('snapshots/v1/3-hash-3.json')
  assert.equal(new TextDecoder().decode(snapshot!), '{"schema_version":1}')
  assert.equal(await store.getSnapshotBytes('snapshots/v1/9-gone.json'), null)

  assert.ok(calls[0].startsWith('https://cdn.example.com/public/current-release.json'))
  assert.match(calls[calls.length - 1], /snapshots\/v1\/9-gone\.json$/)
})

test('HttpPublicStore encodes key segments and refuses traversal keys', async () => {
  const { impl, calls } = fetchOver({ 'images/ab/original': 'bytes' })
  const store = new HttpPublicStore('https://cdn.example.com/', undefined, { fetch: impl })
  const bytes = await store.getSnapshotBytes('images/ab/original')
  assert.equal(new TextDecoder().decode(bytes!), 'bytes')
  assert.equal(calls[0], 'https://cdn.example.com/images/ab/original')
  await assert.rejects(() => store.getSnapshotBytes('images/../secret'), /non-object key/)
})

test('HttpPublicStore fails closed on unexpected HTTP statuses and malformed pointers', async () => {
  const { impl } = fetchOver({ 'public/current-release.json': 'not json' })
  const store = new HttpPublicStore('https://cdn.example.com', undefined, { fetch: impl })
  await assert.rejects(() => store.getCurrentRelease(), /Invalid public release pointer/)

  const failing = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch
  const errorStore = new HttpPublicStore('https://cdn.example.com', undefined, { fetch: failing })
  await assert.rejects(() => errorStore.getSnapshotBytes('snapshots/v1/1-x.json'), /HTTP 500/)
  await assert.rejects(() => errorStore.getCurrentRelease(), /HTTP 500/)
})

test('HttpPublicStore is read-only: writes throw and pointer commits report unsupported', async () => {
  const { impl } = fetchOver({})
  const store = new HttpPublicStore('https://cdn.example.com', undefined, { fetch: impl })
  await assert.rejects(
    () => store.putImmutableObject('snapshots/v1/1-a.json', new Uint8Array(), 'application/json'),
    /read-only/,
  )
  assert.equal(await store.commitRelease(pointer(1), pointer(2)), 'unsupported')
})

test('HttpPublicStore rejects non-https and placeholder base URLs', () => {
  assert.throws(() => new HttpPublicStore('http://cdn.example.com'), /must use https/)
  assert.throws(() => new HttpPublicStore('https://PLACEHOLDER_PUBLIC_CDN'), /placeholder/i)
  assert.throws(() => new HttpPublicStore('cdn.example.com'), /absolute/)
})

test('HttpPublicStore allows insecure http only for local adapters', async () => {
  const { impl } = fetchOver({ 'public/current-release.json': JSON.stringify(pointer(1)) })
  const store = new HttpPublicStore('http://127.0.0.1:9000', undefined, { fetch: impl })
  assert.deepEqual(await store.getCurrentRelease(), pointer(1))
})
