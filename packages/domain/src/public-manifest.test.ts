import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicCalendarDayV1, PublicCollectionItemV1 } from '@airing-cal/storage'
import { buildPublicSnapshot } from './public-snapshot.ts'
import {
  buildManifest,
  parsePublicSnapshotManifestV1,
  snapshotKey,
} from './public-manifest.ts'

const hash = 'a'.repeat(64)
const gitSha = 'b'.repeat(40)

function item(): PublicCollectionItemV1 {
  return {
    subject_id: 1, name: 'Subject', name_cn: '', summary: '',
    images: { common: null, large: null },
    image_status: { common: 'pending_next_cron', large: 'pending_next_cron' },
    eps: 0, total_episodes: 0, ep_status: 0, vol_status: 0, type: 2,
    collection_type: 1, rate: 0, nsfw: false, date: '', tags: [], updated_at: '',
  }
}

const calendar: PublicCalendarDayV1[] = []

async function snapshot(generation = 7, publishedAt = 1_722_000_000) {
  return buildPublicSnapshot({ collections: [item()], calendar, published_at: publishedAt }, generation)
}

test('buildManifest produces the exact V1 contract from a snapshot', async () => {
  const value = await snapshot()
  const manifest = buildManifest(value, {
    source_observed_at: '2024-07-26T18:40:01.000Z',
    git_sha: gitSha,
  })

  assert.deepEqual(Object.keys(manifest).sort(), [
    'content_sha256', 'generation', 'git_sha', 'item_count', 'published_at',
    'schema_version', 'snapshot_key', 'source_observed_at',
  ])
  assert.equal(manifest.generation, value.generation)
  assert.equal(manifest.content_sha256, value.content_hash)
  assert.equal(manifest.snapshot_key, `snapshots/v1/${value.generation}-${value.content_hash}.json`)
  assert.equal(manifest.published_at, new Date(value.published_at * 1000).toISOString())
  assert.equal(manifest.source_observed_at, '2024-07-26T18:40:01.000Z')
  assert.equal(manifest.item_count, value.summary._total)
  assert.deepEqual(parsePublicSnapshotManifestV1(structuredClone(manifest)), manifest)
})

test('manifest parser rejects non-exact timestamps, identities, counters, and keys', async () => {
  const value = buildManifest(await snapshot(), {
    source_observed_at: '2024-07-26T18:40:01.000Z', git_sha: gitSha,
  })
  const invalidValues = [
    { ...value, extra: true },
    { ...value, published_at: '2024-07-26T18:40:00Z' },
    { ...value, source_observed_at: '2024-07-26T20:40:01.000+02:00' },
    { ...value, item_count: -1 },
    { ...value, git_sha: gitSha.toUpperCase() },
    { ...value, content_sha256: hash },
    { ...value, snapshot_key: snapshotKey(value.generation + 1, value.content_sha256) },
    { ...value, snapshot_key: snapshotKey(value.generation, hash) },
  ]

  for (const invalid of invalidValues) {
    assert.throws(() => parsePublicSnapshotManifestV1(invalid), /Invalid public snapshot manifest/)
  }
})

test('snapshotKey only accepts a non-negative generation and lowercase SHA-256', () => {
  assert.equal(snapshotKey(7, hash), `snapshots/v1/7-${hash}.json`)
  assert.throws(() => snapshotKey(-1, hash), /Invalid snapshot key/)
  assert.throws(() => snapshotKey(1.5, hash), /Invalid snapshot key/)
  assert.throws(() => snapshotKey(1, hash.toUpperCase()), /Invalid snapshot key/)
})
