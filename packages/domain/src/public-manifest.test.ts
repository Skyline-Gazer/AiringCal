import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PublicCollectionItemV1,
  PublicSnapshotV1,
} from '@airing-cal/storage'
import { canonicalJson } from '@airing-cal/storage'
import type {
  PublicSnapshotManifestMetadata,
  PublicSnapshotManifestV1,
} from './index.ts'
import * as domain from './index.ts'
import { buildPublicSnapshot } from './public-snapshot.ts'

interface ManifestApi {
  buildManifest(snapshot: PublicSnapshotV1, metadata: PublicSnapshotManifestMetadata): PublicSnapshotManifestV1
  parsePublicSnapshotManifestV1(value: unknown): PublicSnapshotManifestV1
  snapshotKey(generation: number, hash: string): string
  canonicalSnapshotBytes(snapshot: PublicSnapshotV1): Uint8Array
  nextSnapshotGeneration(
    verified: { generation: number; content_hash: string } | null,
    contentHash: string,
  ): number | null
}

const api = domain as unknown as Partial<ManifestApi>
const gitSha = 'c'.repeat(40)
const publishedAt = 1_722_000_000

function collectionItem(subject_id: number): PublicCollectionItemV1 {
  return {
    subject_id,
    name: `Subject ${subject_id}`,
    name_cn: '',
    summary: '',
    images: { common: null, large: null },
    image_status: { common: 'missing_source', large: 'missing_source' },
    eps: 0,
    total_episodes: 0,
    ep_status: 0,
    vol_status: 0,
    type: 2,
    collection_type: 3,
    rate: 0,
    nsfw: false,
    date: '',
    tags: [],
    updated_at: '',
  }
}

async function buildSnapshot(published_at = publishedAt): Promise<PublicSnapshotV1> {
  return buildPublicSnapshot({
    collections: [collectionItem(1)],
    calendar: [],
    published_at,
  }, 9)
}

async function buildValidManifest(): Promise<PublicSnapshotManifestV1> {
  assert.equal(typeof api.buildManifest, 'function', 'buildManifest must be exported')
  return api.buildManifest!(await buildSnapshot(), {
    source_observed_at: publishedAt + 60,
    git_sha: gitSha,
  })
}

test('buildManifest emits exact keys and UTC times tied to the public snapshot', async () => {
  const snapshot = await buildSnapshot()
  assert.equal(typeof snapshot.published_at, 'number')
  assert.equal(Number.isSafeInteger(snapshot.published_at), true)
  assert.equal(typeof api.buildManifest, 'function', 'buildManifest must be exported')

  const manifest = api.buildManifest!(snapshot, {
    source_observed_at: publishedAt + 60,
    git_sha: gitSha,
  })

  assert.deepEqual(Object.keys(manifest).sort(), [
    'content_sha256',
    'generation',
    'git_sha',
    'item_count',
    'published_at',
    'schema_version',
    'snapshot_key',
    'source_observed_at',
  ])
  assert.equal(manifest.schema_version, 1)
  assert.equal(manifest.generation, snapshot.generation)
  assert.equal(manifest.snapshot_key, 'snapshots/v1/9-' + snapshot.content_hash + '.json')
  assert.equal(manifest.content_sha256, snapshot.content_hash)
  assert.equal(manifest.published_at, new Date(publishedAt * 1_000).toISOString())
  assert.equal(manifest.source_observed_at, new Date((publishedAt + 60) * 1_000).toISOString())
  assert.equal(manifest.item_count, snapshot.summary._total)
  assert.equal(manifest.git_sha, gitSha)
})

test('manifest parser accepts valid manifests and rejects key, value, and UTC violations', async () => {
  const manifest = await buildValidManifest()
  assert.equal(typeof api.parsePublicSnapshotManifestV1, 'function', 'manifest parser must be exported')
  assert.deepEqual(api.parsePublicSnapshotManifestV1!(manifest), manifest)

  const missingKey: Partial<PublicSnapshotManifestV1> = { ...manifest }
  delete missingKey.snapshot_key
  const invalidValues: unknown[] = [
    { ...manifest, extra: true },
    missingKey,
    { ...manifest, schema_version: 2 },
    { ...manifest, generation: -1 },
    { ...manifest, content_sha256: 'A'.repeat(64) },
    { ...manifest, snapshot_key: 'snapshots/v1/8-' + manifest.content_sha256 + '.json' },
    { ...manifest, published_at: '2026-09-15T00:00:00+00:00' },
    { ...manifest, source_observed_at: 'not-a-date' },
    { ...manifest, item_count: -1 },
    { ...manifest, git_sha: 'A'.repeat(40) },
    { ...manifest, git_sha: 'c'.repeat(39) },
  ]

  for (const value of invalidValues) {
    assert.throws(
      () => api.parsePublicSnapshotManifestV1!(value),
      /Invalid public snapshot manifest/,
    )
  }
})

test('snapshotKey shares the immutable key grammar and snapshot bytes are canonical JSON', async () => {
  const snapshot = await buildSnapshot()
  assert.equal(typeof api.snapshotKey, 'function', 'snapshotKey must be exported')
  assert.equal(
    api.snapshotKey!(snapshot.generation, snapshot.content_hash),
    'snapshots/v1/9-' + snapshot.content_hash + '.json',
  )
  assert.throws(() => api.snapshotKey!(-1, snapshot.content_hash), /Invalid/)
  assert.throws(() => api.snapshotKey!(9, 'A'.repeat(64)), /Invalid/)

  assert.equal(typeof api.canonicalSnapshotBytes, 'function', 'canonical snapshot bytes helper must be exported')
  const bytes = api.canonicalSnapshotBytes!(snapshot)
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as PublicSnapshotV1
  assert.ok(bytes instanceof Uint8Array)
  assert.equal(new TextDecoder().decode(bytes), canonicalJson(snapshot))
  assert.deepEqual(api.canonicalSnapshotBytes!(reordered), bytes)
})

test('nextSnapshotGeneration is a pure no-op or sequential allocation decision', async () => {
  const snapshot = await buildSnapshot()
  assert.equal(typeof api.nextSnapshotGeneration, 'function', 'generation helper must be exported')
  const helper = api.nextSnapshotGeneration!
  assert.equal(helper(null, snapshot.content_hash), 1)
  assert.equal(helper({ generation: 7, content_hash: snapshot.content_hash }, snapshot.content_hash), null)
  assert.equal(helper({ generation: 7, content_hash: '0'.repeat(64) }, snapshot.content_hash), 8)
})
