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

  async match(request: Request): Promise<Response | undefined> {
    return this.values.get(request.url)
  }

  async put(request: Request, response: Response): Promise<void> {
    this.values.set(request.url, response)
  }
}

function installManifest(r2: FakeR2, manifest: PublicSnapshotManifestV1, snapshot: PublicSnapshotV1): void {
  r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
  r2.objects.set(manifest.snapshot_key, JSON.stringify(snapshot))
}

test('readSnapshotSource loads the exact R2 manifest and its immutable snapshot', async () => {
  const { manifest, snapshot } = await fixture()
  const r2 = new FakeR2()
  installManifest(r2, manifest, snapshot)

  const source = await readSnapshotSource(r2, new FakeCache())

  assert.equal(source.mode, 'r2')
  if (source.mode === 'r2') assert.deepEqual(source.snapshot, snapshot)
  assert.deepEqual(r2.calls, [MANIFEST_KEY, manifest.snapshot_key])
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

test('readSnapshotSource keeps a cached snapshot only after validating it against the R2 manifest', async () => {
  const { manifest, snapshot } = await fixture()
  const r2 = new FakeR2()
  r2.objects.set(MANIFEST_KEY, JSON.stringify(manifest))
  r2.failingKeys.add(manifest.snapshot_key)
  const cache = new FakeCache()
  await cache.put(
    new Request('https://cache.local/r2-snapshot/' + manifest.content_sha256),
    new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } }),
  )

  const source = await readSnapshotSource(r2, cache)

  assert.equal(source.mode, 'r2')
  if (source.mode === 'r2') assert.deepEqual(source.snapshot, snapshot)
})

test('readSnapshotSource returns legacy when the live manifest is absent', async () => {
  const r2 = new FakeR2()

  assert.deepEqual(await readSnapshotSource(r2, new FakeCache()), { mode: 'legacy' })
  assert.deepEqual(r2.calls, [MANIFEST_KEY])
})
