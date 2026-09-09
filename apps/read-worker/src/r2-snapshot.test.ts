import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManifest, buildPublicSnapshot, type PublicSnapshotManifestV1 } from '@airing-cal/domain'
import type { PublicSnapshotPointerV1, PublicSnapshotV1 } from '@airing-cal/storage'
import { loadVerifiedSnapshot, readSnapshotSource, type ReadSnapshotCache, type ReadSnapshotDataR2, type ReadSnapshotKv } from './r2-snapshot.ts'

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

async function fixture(generation = 9): Promise<{ manifest: PublicSnapshotManifestV1; snapshot: PublicSnapshotV1 }> {
  const snapshot = await buildPublicSnapshot({ collections: [], calendar: [], published_at: 1_000 }, generation)
  return {
    snapshot,
    manifest: buildManifest(snapshot, {
      source_observed_at: '1970-01-01T00:16:41.000Z',
      git_sha: 'a'.repeat(40),
    }),
  }
}

class FakeR2 implements ReadSnapshotDataR2 {
  objects = new Map<string, string>()

  async get(key: string): Promise<{ key: string; text(): Promise<string> } | null> {
    const value = this.objects.get(key)
    return value === undefined ? null : { key, async text() { return value } }
  }
}

class FakeKv implements ReadSnapshotKv {
  values = new Map<string, unknown>()

  async get(key: string, _type: 'json'): Promise<unknown> {
    return this.values.get(key) ?? null
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

class ThrowingR2 extends FakeR2 {
  constructor(private readonly failingKey: string) {
    super()
  }

  override async get(key: string): Promise<{ key: string; text(): Promise<string> } | null> {
    if (key === this.failingKey) throw new Error(`R2 get failed for ${key}`)
    return await super.get(key)
  }
}

class ThrowingCache extends FakeCache {
  override async put(_request: Request, _response: Response): Promise<void> {
    throw new Error('Cache put failed')
  }
}

test('loads an immutable snapshot named by public/manifest.json', async () => {
  const { manifest, snapshot } = await fixture()
  const r2 = new FakeR2()
  r2.objects.set('public/manifest.json', JSON.stringify(manifest))
  r2.objects.set(manifest.snapshot_key, JSON.stringify(snapshot))

  assert.deepEqual(await readSnapshotSource(r2), { mode: 'r2', snapshot })
})

test('rejects malformed manifests', async () => {
  const { manifest } = await fixture()
  const invalid = [
    { ...manifest, schema_version: 2 },
    { ...manifest, extra: true },
    Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'git_sha')),
    { ...manifest, published_at: 'not-a-timestamp' },
    { ...manifest, git_sha: 'A'.repeat(40) },
    { ...manifest, item_count: 1 },
    { ...manifest, snapshot_key: 'snapshots/v1/9-wrong.json' },
    { ...manifest, content_sha256: 'f'.repeat(64) },
  ]
  for (const value of invalid) {
    const r2 = new FakeR2()
    r2.objects.set('public/manifest.json', JSON.stringify(value))
    assert.deepEqual(await readSnapshotSource(r2), { mode: 'legacy' })
  }
})

test('rejects a truncated manifest and snapshot', async () => {
  const { manifest, snapshot } = await fixture()
  const manifestR2 = new FakeR2()
  manifestR2.objects.set('public/manifest.json', '{')
  assert.deepEqual(await readSnapshotSource(manifestR2), { mode: 'legacy' })

  const snapshotR2 = new FakeR2()
  snapshotR2.objects.set('public/manifest.json', JSON.stringify(manifest))
  snapshotR2.objects.set(manifest.snapshot_key, JSON.stringify(snapshot).slice(0, -1))
  assert.equal(await loadVerifiedSnapshot(snapshotR2, manifest), null)
})

test('rejects a snapshot that disagrees with its validated manifest', async () => {
  const { manifest, snapshot } = await fixture()
  const r2 = new FakeR2()
  r2.objects.set(manifest.snapshot_key, JSON.stringify({ ...snapshot, published_at: 1_001 }))
  assert.equal(await loadVerifiedSnapshot(r2, manifest), null)
})

test('falls back to the complete legacy source when manifest R2 get throws', async () => {
  assert.deepEqual(await readSnapshotSource(new ThrowingR2('public/manifest.json')), { mode: 'legacy' })
})

test('falls back to the complete legacy source when snapshot R2 get throws', async () => {
  const { manifest } = await fixture()
  const r2 = new ThrowingR2(manifest.snapshot_key)
  r2.objects.set('public/manifest.json', JSON.stringify(manifest))

  assert.deepEqual(await readSnapshotSource(r2), { mode: 'legacy' })
})

test('warms the old cache after a legacy pointer R2 snapshot is verified', async () => {
  const { snapshot } = await fixture()
  const kv = new FakeKv()
  const pointerValue = { ...pointer(), content_hash: snapshot.content_hash, r2_key: `snapshots/v1/9-${snapshot.content_hash}.json` }
  kv.values.set('public:read-mode', { mode: 'r2' })
  kv.values.set('public:current', pointerValue)
  const cache = new FakeCache()
  const r2 = new FakeR2()
  r2.objects.set(pointerValue.r2_key, JSON.stringify(snapshot))

  assert.deepEqual(await readSnapshotSource(r2, kv, cache), { mode: 'r2', snapshot })
  const cached = await cache.match(new Request(`https://cache.local/r2-snapshot/${snapshot.content_hash}`))
  assert.deepEqual(await cached?.json(), snapshot)
})

test('serves a verified legacy pointer R2 snapshot when cache warming fails', async () => {
  const { snapshot } = await fixture()
  const kv = new FakeKv()
  const pointerValue = { ...pointer(), content_hash: snapshot.content_hash, r2_key: `snapshots/v1/9-${snapshot.content_hash}.json` }
  kv.values.set('public:read-mode', { mode: 'r2' })
  kv.values.set('public:current', pointerValue)
  const r2 = new FakeR2()
  r2.objects.set(pointerValue.r2_key, JSON.stringify(snapshot))

  assert.deepEqual(await readSnapshotSource(r2, kv, new ThrowingCache()), { mode: 'r2', snapshot })
})

test('falls back to the previously verified cache when manifest R2 get fails', async () => {
  const { snapshot } = await fixture()
  const kv = new FakeKv()
  const pointerValue = { ...pointer(), content_hash: snapshot.content_hash, r2_key: `snapshots/v1/9-${snapshot.content_hash}.json` }
  kv.values.set('public:read-mode', { mode: 'r2' })
  kv.values.set('public:current', pointerValue)
  const cache = new FakeCache()
  await cache.put(
    new Request(`https://cache.local/r2-snapshot/${snapshot.content_hash}`),
    new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } }),
  )

  assert.deepEqual(await readSnapshotSource(new ThrowingR2('public/manifest.json'), kv, cache), { mode: 'r2', snapshot })
})

test('falls back to the previously verified cache when the manifest snapshot is missing', async () => {
  const { manifest, snapshot } = await fixture()
  const kv = new FakeKv()
  const pointerValue = { ...pointer(), content_hash: snapshot.content_hash, r2_key: `snapshots/v1/9-${snapshot.content_hash}.json` }
  kv.values.set('public:read-mode', { mode: 'r2' })
  kv.values.set('public:current', pointerValue)
  const cache = new FakeCache()
  await cache.put(
    new Request(`https://cache.local/r2-snapshot/${snapshot.content_hash}`),
    new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } }),
  )
  const r2 = new FakeR2()
  r2.objects.set('public/manifest.json', JSON.stringify(manifest))

  assert.deepEqual(await readSnapshotSource(r2, kv, cache), { mode: 'r2', snapshot })
})

test('falls back to legacy when manifest R2 get fails and the old cache misses', async () => {
  const kv = new FakeKv()
  kv.values.set('public:read-mode', { mode: 'r2' })
  kv.values.set('public:current', pointer())

  assert.deepEqual(await readSnapshotSource(new ThrowingR2('public/manifest.json'), kv, new FakeCache()), { mode: 'legacy' })
})
