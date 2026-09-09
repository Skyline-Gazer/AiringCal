import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManifest, buildPublicSnapshot, type PublicSnapshotManifestV1 } from '@airing-cal/domain'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import { loadVerifiedSnapshot, readSnapshotSource, type ReadSnapshotDataR2 } from './r2-snapshot.ts'

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

class ThrowingR2 extends FakeR2 {
  constructor(private readonly failingKey: string) {
    super()
  }

  override async get(key: string): Promise<{ key: string; text(): Promise<string> } | null> {
    if (key === this.failingKey) throw new Error(`R2 get failed for ${key}`)
    return await super.get(key)
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
