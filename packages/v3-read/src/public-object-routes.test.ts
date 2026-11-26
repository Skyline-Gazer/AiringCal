import test from 'node:test'
import assert from 'node:assert/strict'
import { handlePortableReadRequest } from './portable-read-handler.ts'
import { matchPublicObjectPath } from './public-object-routes.ts'
import type { PublicStore } from '@airing-cal/v3-core/ports'

const HASH = '2613eb5d9a6308c9e4b380937e15e42aa0972768d61f358f1831e80541f16670'

function fakeStore(objects: Record<string, { bytes: Uint8Array; contentType?: string }>): PublicStore {
  return {
    async getCurrentRelease() {
      return null
    },
    async headObject(key: string) {
      const o = objects[key]
      if (!o) return null
      return { size: o.bytes.length, etag: null, contentType: o.contentType ?? null }
    },
    async getSnapshotBytes(key: string) {
      return objects[key]?.bytes ?? null
    },
    async putImmutableObject(key: string): Promise<void> {
      throw new Error(`unexpected write ${key}`)
    },
    async commitRelease(): Promise<never> {
      throw new Error('unexpected commit')
    },
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

test('pointer and legacy manifest are served from the store with short cache', async () => {
  const pointer = enc('{"generation":4,"content_hash":"' + HASH + '","artifact_ref":"snapshots/v1/4-' + HASH + '.json"}')
  const store = fakeStore({
    'public/current-release.json': { bytes: pointer },
    'public/manifest.json': { bytes: enc('{"ok":true}') },
  })
  const res = await handlePortableReadRequest(new Request('https://reader.test/public/current-release.json'), { publicStore: store })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.equal(await res.text(), new TextDecoder().decode(pointer))

  const legacy = await handlePortableReadRequest(new Request('https://reader.test/public/manifest.json'), { publicStore: store })
  assert.equal(legacy.status, 200)

  const viaApiAlias = await handlePortableReadRequest(new Request('https://reader.test/api/public/current-release.json'), { publicStore: store })
  assert.equal(viaApiAlias.status, 200, '/api prefix normalizes onto the same allowlisted route')
})

test('content-addressed snapshot/manifest/image keys serve immutable cache', async () => {
  const snapshotKey = `snapshots/v1/4-${HASH}.json`
  const manifestKey = `public/manifests/4-${HASH}.json`
  const originalKey = `images/${HASH}/original`
  const thumbKey = `images/${HASH}/thumb.v2.webp`
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  const store = fakeStore({
    [snapshotKey]: { bytes: enc('{}') },
    [manifestKey]: { bytes: enc('{}') },
    [originalKey]: { bytes: png, contentType: 'application/octet-stream' },
    [thumbKey]: { bytes: webp, contentType: 'application/octet-stream' },
  })
  const snap = await handlePortableReadRequest(new Request(`https://reader.test/${snapshotKey}`), { publicStore: store })
  assert.equal(snap.status, 200)
  assert.match(snap.headers.get('cache-control') ?? '', /immutable/)

  const man = await handlePortableReadRequest(new Request(`https://reader.test/${manifestKey}`), { publicStore: store })
  assert.equal(man.status, 200)

  const original = await handlePortableReadRequest(new Request(`https://reader.test/${originalKey}`), { publicStore: store })
  assert.equal(original.status, 200)
  assert.equal(original.headers.get('content-type'), 'image/png', 'stored octet-stream original is sniffed to its real MIME')

  const thumb = await handlePortableReadRequest(new Request(`https://reader.test/${thumbKey}`), { publicStore: store })
  assert.equal(thumb.headers.get('content-type'), 'image/webp')
})

test('non-allowlisted keys are refused without ever reading the denied object', async () => {
  const readKeys: string[] = []
  const store: PublicStore = {
    async getCurrentRelease() {
      readKeys.push('pointer')
      return null
    },
    async getSnapshotBytes(key: string) {
      readKeys.push(key)
      return enc('secret')
    },
    async putImmutableObject(key: string): Promise<void> {
      throw new Error(`unexpected write ${key}`)
    },
    async commitRelease(): Promise<never> {
      throw new Error('unexpected commit')
    },
  }
  const denied = [
    '/checkpoints/latest.sqlite',
    '/checkpoints/_isolation-probe.txt',
    '/private/x.json',
    '/snapshots/v1/abc.json',
    '/snapshots/v1/4-DEADBEEF.json',
    '/snapshots/v1/04-' + HASH + '.json',
    '/snapshots/v2/4-' + HASH + '.json',
    '/public/manifests/latest.json',
    '/images/' + HASH.toUpperCase() + '/original',
    '/images/' + HASH + '/evil',
    '/images/' + HASH + '/../checkpoints/latest.sqlite',
    '/public/current-release.json/../..',
    '/..%2fcheckpoints/latest.sqlite',
  ]
  for (const path of denied) {
    readKeys.length = 0
    const res = await handlePortableReadRequest(new Request(`https://reader.test${path}`), { publicStore: store })
    assert.notEqual(res.status, 200, `${path} must not be served`)
    assert.equal(res.status, 404, `${path} must 404 even with no published release (ShipReview #3)`)
    assert.ok(
      readKeys.every((k) => k === 'pointer' || k === 'public/manifest.json'),
      `${path} must never be read from the store (reads: ${readKeys.join(',')})`,
    )
    const body = await res.text()
    assert.notEqual(body, 'secret', `${path} must not leak private object bytes`)
  }
})

test('public object routes refuse writes with 405 + Allow', async () => {
  const store = fakeStore({ 'public/current-release.json': { bytes: enc('{}') } })
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await handlePortableReadRequest(new Request('https://reader.test/public/current-release.json', { method }), { publicStore: store })
    assert.equal(res.status, 405, `${method} must be refused`)
    assert.equal(res.headers.get('allow'), 'GET, HEAD')
  }
})

test('HEAD on an allowlisted object is accepted (runtime strips the body)', async () => {
  const store = fakeStore({ 'public/current-release.json': { bytes: enc('{"a":1}') } })
  const res = await handlePortableReadRequest(new Request('https://reader.test/public/current-release.json', { method: 'HEAD' }), { publicStore: store })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
})

test('matchPublicObjectPath rejects uppercase and malformed generations', () => {
  assert.equal(matchPublicObjectPath('/snapshots/v1/04-' + HASH + '.json'), null, 'zero-padded generation is not the canonical shape')
  assert.equal(matchPublicObjectPath('/public/manifests/4-' + HASH.slice(0, 63) + 'g.json'), null)
  assert.ok(matchPublicObjectPath('/snapshots/v1/0-' + HASH + '.json'), 'generation 0 is a valid number shape')
})
