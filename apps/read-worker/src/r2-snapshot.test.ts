import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManifest, buildPublicSnapshot } from '@airing-cal/domain'
import type { PublicSnapshotManifestV1 } from '@airing-cal/domain'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import {
  readSnapshotSource,
  type ReadSnapshotCache,
  type ReadSnapshotDataR2,
} from './r2-snapshot.ts'

const MANIFEST_KEY = 'public/manifest.json'
const GIT_SHA = 'b'.repeat(40)
const CACHE_PREFIX = 'https://cache.local/r2-snapshot/'

function pairCacheRequest(manifest: PublicSnapshotManifestV1): Request {
  return new Request(`${CACHE_PREFIX}${manifest.generation}-${manifest.content_sha256}`)
}

function lastVerifiedCacheRequest(): Request {
  return new Request(`${CACHE_PREFIX}last-verified`)
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

async function fixture(generation = 9): Promise<{ manifest: PublicSnapshotManifestV1; snapshot: PublicSnapshotV1 }> {
  const snapshot = await buildPublicSnapshot({
    collections: [],
    calendar: [],
    published_at: 1_000,
  }, generation)
  const manifest = buildManifest(snapshot, {
    source_observed_at: 2_000,
    git_sha: GIT_SHA,
  })
  return { manifest, snapshot }
}

class FakeR2 implements ReadSnapshotDataR2 {
  objects = new Map<string, string>()
  calls: string[] = []
  failingKeys = new Set<string>()
  returnedKeys = new Map<string, string>()

  async get(key: string): Promise<{ key: string; text(): Promise<string> } | null> {
    this.calls.push(key)
    if (this.failingKeys.has(key)) throw new Error('injected R2 GET failure')
    const value = this.objects.get(key)
    return value === undefined
      ? null
      : { key: this.returnedKeys.get(key) ?? key, async text() { return value } }
  }
}

class FakeCache implements ReadSnapshotCache {
  values = new Map<string, Response>()
  failMatch = false
  failPut = false

  async match(request: Request): Promise<Response | undefined> {
    if (this.failMatch) throw new Error('injected Cache API match failure')
    return this.values.get(request.url)?.clone()
  }

  async put(request: Request, response: Response): Promise<void> {
    if (this.failPut) throw new Error('injected Cache API put failure')
    this.values.set(request.url, response.clone())
  }
}

async function seedVerifiedCache(
  cache: FakeCache,
  manifest: PublicSnapshotManifestV1,
  snapshot: PublicSnapshotV1,
): Promise<void> {
  await cache.put(pairCacheRequest(manifest), jsonResponse({ manifest, snapshot }))
  await cache.put(lastVerifiedCacheRequest(), jsonResponse({
    generation: manifest.generation,
    content_sha256: manifest.content_sha256,
  }))
}

function installManifest(r2: FakeR2, manifest: PublicSnapshotManifestV1, snapshot: PublicSnapshotV1): void {
  r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
  r2.objects.set(manifest.snapshot_key, JSON.stringify(snapshot))
}

test('readSnapshotSource loads the exact R2 manifest and its immutable snapshot', async () => {
  const { manifest, snapshot } = await fixture()
  const r2 = new FakeR2()
  const cache = new FakeCache()
  installManifest(r2, manifest, snapshot)

  const source = await readSnapshotSource(r2, cache)

  assert.equal(source.mode, 'r2')
  if (source.mode === 'r2') {
    assert.deepEqual(source.manifest, manifest)
    assert.deepEqual(source.snapshot, snapshot)
  }
  assert.deepEqual(r2.calls, [MANIFEST_KEY, manifest.snapshot_key])
  assert.ok(cache.values.has(pairCacheRequest(manifest).url))
  assert.ok(cache.values.has(lastVerifiedCacheRequest().url))
})

test('readSnapshotSource gives verified cache entries a long freshness window', async () => {
  const { manifest, snapshot } = await fixture()
  const r2 = new FakeR2()
  const cache = new FakeCache()
  installManifest(r2, manifest, snapshot)

  await readSnapshotSource(r2, cache)

  assert.equal(
    cache.values.get(pairCacheRequest(manifest).url)?.headers.get('Cache-Control'),
    'public, max-age=2592000, immutable',
  )
  assert.equal(
    cache.values.get(lastVerifiedCacheRequest().url)?.headers.get('Cache-Control'),
    'public, max-age=2592000',
  )
})

test('readSnapshotSource rejects malformed manifests before loading a snapshot', async () => {
  const { manifest } = await fixture()
  const { git_sha: _gitSha, ...missingGitSha } = manifest
  const invalidManifests: unknown[] = [
    { ...manifest, schema_version: 2 },
    { ...manifest, extra: true },
    missingGitSha,
    { ...manifest, published_at: 'not-a-time' },
    { ...manifest, source_observed_at: '2026-09-15T00:00:00Z' },
    { ...manifest, git_sha: GIT_SHA.toUpperCase() },
    { ...manifest, item_count: -1 },
    { ...manifest, snapshot_key: 'snapshots/v1/10-' + manifest.content_sha256 + '.json' },
    { ...manifest, content_sha256: 'invalid' },
  ]

  for (const invalidManifest of invalidManifests) {
    const r2 = new FakeR2()
    r2.objects.set(MANIFEST_KEY, JSON.stringify(invalidManifest))

    assert.deepEqual(await readSnapshotSource(r2, new FakeCache()), { mode: 'legacy' })
    assert.deepEqual(r2.calls, [MANIFEST_KEY])
  }
})

test('readSnapshotSource rejects a valid manifest when snapshot metadata disagrees', async () => {
  const { manifest, snapshot } = await fixture()
  const mismatchedManifests = [
    { ...manifest, item_count: manifest.item_count + 1 },
    { ...manifest, published_at: '1970-01-01T00:00:03.000Z' },
    { ...manifest, content_sha256: 'd'.repeat(64), snapshot_key: 'snapshots/v1/9-' + 'd'.repeat(64) + '.json' },
  ]

  for (const mismatchedManifest of mismatchedManifests) {
    const r2 = new FakeR2()
    installManifest(r2, mismatchedManifest, snapshot)

    assert.deepEqual(await readSnapshotSource(r2, new FakeCache()), { mode: 'legacy' })
  }
})

test('readSnapshotSource rejects a snapshot with a different generation or returned object key', async () => {
  const { manifest } = await fixture()
  const { snapshot: otherGeneration } = await fixture(manifest.generation + 1)
  const r2 = new FakeR2()
  installManifest(r2, manifest, otherGeneration)

  assert.deepEqual(await readSnapshotSource(r2, new FakeCache()), { mode: 'legacy' })

  const wrongKeyR2 = new FakeR2()
  const { snapshot } = await fixture()
  wrongKeyR2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
  wrongKeyR2.objects.set(manifest.snapshot_key, JSON.stringify(snapshot))
  wrongKeyR2.returnedKeys.set(manifest.snapshot_key, 'wrong-key')

  assert.deepEqual(await readSnapshotSource(wrongKeyR2, new FakeCache()), { mode: 'legacy' })
})

test('readSnapshotSource rejects a structurally valid snapshot with a tampered payload hash', async () => {
  const { manifest, snapshot } = await fixture()
  const r2 = new FakeR2()
  r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
  r2.objects.set(manifest.snapshot_key, JSON.stringify({
    ...snapshot,
    published_at: snapshot.published_at + 1,
  }))

  assert.deepEqual(await readSnapshotSource(r2, new FakeCache()), { mode: 'legacy' })
})

test('readSnapshotSource rejects a missing or truncated snapshot object', async () => {
  const { manifest, snapshot } = await fixture()

  for (const snapshotValue of [undefined, '{']) {
    const r2 = new FakeR2()
    r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
    if (snapshotValue !== undefined) r2.objects.set(manifest.snapshot_key, snapshotValue)

    assert.deepEqual(await readSnapshotSource(r2, new FakeCache()), { mode: 'legacy' })
  }

  const r2 = new FakeR2()
  installManifest(r2, manifest, snapshot)
  r2.objects.set(manifest.snapshot_key, '{')
  assert.deepEqual(await readSnapshotSource(r2, new FakeCache()), { mode: 'legacy' })
})

test('readSnapshotSource serves the revalidated last-verified pair through R2 outages', async () => {
  const { manifest, snapshot } = await fixture()
  const cache = new FakeCache()
  const warmR2 = new FakeR2()
  installManifest(warmR2, manifest, snapshot)
  assert.equal((await readSnapshotSource(warmR2, cache)).mode, 'r2')

  const outageCases: Array<[string, (r2: FakeR2) => void]> = [
    ['missing manifest', () => {}],
    ['corrupt manifest', (r2) => r2.objects.set(MANIFEST_KEY, '{')],
    ['offline manifest', (r2) => r2.failingKeys.add(MANIFEST_KEY)],
    ['missing snapshot', (r2) => r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))],
    ['corrupt snapshot', (r2) => {
      r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
      r2.objects.set(manifest.snapshot_key, '{')
    }],
    ['offline snapshot', (r2) => {
      r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
      r2.failingKeys.add(manifest.snapshot_key)
    }],
  ]

  for (const [name, setOutage] of outageCases) {
    const r2 = new FakeR2()
    setOutage(r2)
    const source = await readSnapshotSource(r2, cache)

    assert.equal(source.mode, 'cache', name)
    if (source.mode === 'cache') {
      assert.deepEqual(source.manifest, manifest, name)
      assert.deepEqual(source.snapshot, snapshot, name)
    }
  }
})

test('readSnapshotSource can restore an exact cached pair when the last-verified pointer is absent', async () => {
  const { manifest, snapshot } = await fixture()
  const cache = new FakeCache()
  await cache.put(pairCacheRequest(manifest), jsonResponse({ manifest, snapshot }))
  const r2 = new FakeR2()
  r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
  r2.failingKeys.add(manifest.snapshot_key)

  const source = await readSnapshotSource(r2, cache)
  assert.equal(source.mode, 'cache')
  if (source.mode === 'cache') assert.deepEqual(source.snapshot, snapshot)

  const laterOutage = await readSnapshotSource(new FakeR2(), cache)
  assert.equal(laterOutage.mode, 'cache')
  if (laterOutage.mode === 'cache') assert.deepEqual(laterOutage.manifest, manifest)
})

test('readSnapshotSource caches generation zero accepted by the shared manifest parser', async () => {
  const { manifest, snapshot } = await fixture(0)
  const cache = new FakeCache()
  const r2 = new FakeR2()
  installManifest(r2, manifest, snapshot)

  assert.equal((await readSnapshotSource(r2, cache)).mode, 'r2')

  const source = await readSnapshotSource(new FakeR2(), cache)
  assert.equal(source.mode, 'cache')
  if (source.mode === 'cache') {
    assert.equal(source.manifest.generation, 0)
    assert.deepEqual(source.snapshot, snapshot)
  }
})

test('readSnapshotSource returns the cached manifest and payload as one pair', async () => {
  const cached = await fixture(8)
  const current = await fixture(9)
  const cache = new FakeCache()
  await seedVerifiedCache(cache, cached.manifest, cached.snapshot)
  const r2 = new FakeR2()
  r2.objects.set(MANIFEST_KEY, JSON.stringify(current.manifest))

  const source = await readSnapshotSource(r2, cache)

  assert.equal(source.mode, 'cache')
  if (source.mode === 'cache') {
    assert.deepEqual(source.manifest, cached.manifest)
    assert.deepEqual(source.snapshot, cached.snapshot)
    assert.equal(source.snapshot.generation, source.manifest.generation)
    assert.equal(source.snapshot.content_hash, source.manifest.content_sha256)
  }
})

test('readSnapshotSource rejects a manifest generation rollback without replacing the cache', async () => {
  const cached = await fixture(10)
  const older = await fixture(9)
  const cache = new FakeCache()
  await seedVerifiedCache(cache, cached.manifest, cached.snapshot)
  const r2 = new FakeR2()
  installManifest(r2, older.manifest, older.snapshot)

  const source = await readSnapshotSource(r2, cache)
  const pointer = await cache.match(lastVerifiedCacheRequest())

  assert.equal(source.mode, 'cache')
  if (source.mode === 'cache') {
    assert.deepEqual(source.manifest, cached.manifest)
    assert.deepEqual(source.snapshot, cached.snapshot)
  }
  assert.deepEqual(await pointer?.json(), {
    generation: cached.manifest.generation,
    content_sha256: cached.manifest.content_sha256,
  })
  assert.deepEqual(r2.calls, [MANIFEST_KEY])
})

test('readSnapshotSource rejects same-generation manifests with a different hash', async () => {
  const cached = await fixture(10)
  const cache = new FakeCache()
  await seedVerifiedCache(cache, cached.manifest, cached.snapshot)
  const r2 = new FakeR2()
  const conflict = {
    ...cached.manifest,
    content_sha256: 'd'.repeat(64),
    snapshot_key: `snapshots/v1/10-${'d'.repeat(64)}.json`,
  }
  r2.objects.set(MANIFEST_KEY, JSON.stringify(conflict))

  const source = await readSnapshotSource(r2, cache)

  assert.equal(source.mode, 'cache')
  if (source.mode === 'cache') assert.deepEqual(source.manifest, cached.manifest)
  assert.deepEqual(r2.calls, [MANIFEST_KEY])
})

test('readSnapshotSource fences a late older generation in the same isolate', async () => {
  const previous = await fixture(9)
  const older = await fixture(10)
  const newer = await fixture(11)
  const cache = new FakeCache()
  await seedVerifiedCache(cache, previous.manifest, previous.snapshot)

  let releaseOlderSnapshot!: () => void
  let olderSnapshotStarted!: () => void
  const olderSnapshotGate = new Promise<void>((resolve) => { releaseOlderSnapshot = resolve })
  const olderSnapshotEntered = new Promise<void>((resolve) => { olderSnapshotStarted = resolve })
  const olderR2 = new FakeR2()
  installManifest(olderR2, older.manifest, older.snapshot)
  const getOlderObject = olderR2.get.bind(olderR2)
  olderR2.get = async (key) => {
    if (key === older.manifest.snapshot_key) {
      olderSnapshotStarted()
      await olderSnapshotGate
    }
    return getOlderObject(key)
  }

  const olderRead = readSnapshotSource(olderR2, cache)
  await olderSnapshotEntered

  const newerR2 = new FakeR2()
  installManifest(newerR2, newer.manifest, newer.snapshot)
  assert.equal((await readSnapshotSource(newerR2, cache)).mode, 'r2')
  releaseOlderSnapshot()

  const lateOlderSource = await olderRead
  assert.equal(lateOlderSource.mode, 'cache')
  if (lateOlderSource.mode === 'cache') {
    assert.deepEqual(lateOlderSource.manifest, newer.manifest)
    assert.deepEqual(lateOlderSource.snapshot, newer.snapshot)
  }
  const pointer = await cache.match(lastVerifiedCacheRequest())
  assert.deepEqual(await pointer?.json(), {
    generation: newer.manifest.generation,
    content_sha256: newer.manifest.content_sha256,
  })
})

test('readSnapshotSource rejects a corrupt cached envelope before legacy fallback', async () => {
  const { manifest, snapshot } = await fixture()
  const cache = new FakeCache()
  await seedVerifiedCache(cache, manifest, snapshot)
  await cache.put(pairCacheRequest(manifest), jsonResponse({
    manifest,
    snapshot: { ...snapshot, generation: snapshot.generation + 1 },
  }))

  const source = await readSnapshotSource(new FakeR2(), cache)

  assert.deepEqual(source, { mode: 'legacy' })
})

test('readSnapshotSource serves verified R2 when Cache API warming fails', async () => {
  const { manifest, snapshot } = await fixture()
  const r2 = new FakeR2()
  installManifest(r2, manifest, snapshot)
  const cache = new FakeCache()
  cache.failPut = true

  const source = await readSnapshotSource(r2, cache)

  assert.equal(source.mode, 'r2')
  if (source.mode === 'r2') assert.deepEqual(source.snapshot, snapshot)
})

test('readSnapshotSource returns legacy when the live manifest is absent', async () => {
  const r2 = new FakeR2()

  assert.deepEqual(await readSnapshotSource(r2, new FakeCache()), { mode: 'legacy' })
  assert.deepEqual(r2.calls, [MANIFEST_KEY])
})
