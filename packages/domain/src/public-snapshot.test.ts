import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PublicCalendarDayV1,
  PublicCollectionItemV1,
  PublicSnapshotV1,
} from '@airing-cal/storage'
import {
  buildPublicSnapshot,
  parsePublicSnapshotV1,
  snapshotObjectKey,
} from './public-snapshot.ts'

function collectionItem(
  subject_id: number,
  collection_type: number,
  overrides: Partial<PublicCollectionItemV1> = {},
): PublicCollectionItemV1 {
  return {
    subject_id,
    name: `Subject ${subject_id}`,
    name_cn: '',
    summary: '',
    images: {
      common: {
        hash: 'a'.repeat(64),
        uri: `/image/${'a'.repeat(64)}`,
        r2_key: `images/${'a'.repeat(64)}/original`,
      },
      large: null,
    },
    eps: 12,
    total_episodes: 12,
    ep_status: 2,
    vol_status: 0,
    type: 2,
    collection_type,
    rate: 8,
    nsfw: false,
    date: '2026-07-27',
    tags: ['daily'],
    updated_at: '2026-07-27T00:00:00Z',
    ...overrides,
  }
}

const calendar: PublicCalendarDayV1[] = [{
  weekday: { en: 'Sun', cn: '星期日', ja: '日', id: 7 },
  items: [{
    subject_id: 5,
    id: 5,
    type: 2,
    name: 'Calendar subject',
    name_cn: '',
    summary: '',
    images: {
      common: null,
      large: {
        hash: 'b'.repeat(64),
        uri: `/image/${'b'.repeat(64)}`,
        r2_key: `images/${'b'.repeat(64)}/original`,
      },
    },
    nsfw: true,
    date: '2026-07-27',
    eps: 12,
    total_episodes: 12,
  }],
}]

test('buildPublicSnapshot groups all five collection types and projects summary, images and NSFW', async () => {
  const snapshot = await buildPublicSnapshot({
    collections: [
      collectionItem(1, 1),
      collectionItem(2, 2),
      collectionItem(3, 3, { nsfw: true }),
      collectionItem(4, 4),
      collectionItem(5, 5),
    ],
    calendar,
  }, 41)

  assert.equal(snapshot.schema_version, 1)
  assert.equal(snapshot.generation, 41)
  assert.match(snapshot.content_hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(Object.fromEntries(
    Object.entries(snapshot.collections).map(([key, items]) => [key, items.map((item) => item.subject_id)]),
  ), {
    want: [1],
    watched: [2],
    watching: [3],
    on_hold: [4],
    dropped: [5],
  })
  assert.deepEqual(snapshot.summary, {
    want: 1,
    watched: 1,
    watching: 1,
    on_hold: 1,
    dropped: 1,
    _total: 5,
  })
  assert.equal(snapshot.collections.watching[0]?.nsfw, true)
  assert.equal(snapshot.collections.want[0]?.images.common?.r2_key, `images/${'a'.repeat(64)}/original`)
  assert.equal(snapshot.calendar[0]?.items[0]?.nsfw, true)
  assert.equal(snapshot.calendar[0]?.items[0]?.images.large?.hash, 'b'.repeat(64))
})

test('snapshot content hash excludes generation, content_hash and published_at envelope fields', async () => {
  const input = {
    collections: [collectionItem(1, 1)],
    calendar,
    content_hash: 'ignored',
    published_at: 100,
  }
  const first = await buildPublicSnapshot(input, 1)
  const second = await buildPublicSnapshot({ ...input, content_hash: 'also-ignored', published_at: 999 }, 2)

  assert.equal(first.content_hash, second.content_hash)
})

test('snapshot parser round-trips the known schema and rejects unknown schema precisely', async () => {
  const snapshot = await buildPublicSnapshot({
    collections: [collectionItem(1, 1)],
    calendar,
  }, 3)

  assert.deepEqual(parsePublicSnapshotV1(JSON.parse(JSON.stringify(snapshot))), snapshot)
  assert.throws(
    () => parsePublicSnapshotV1({ ...snapshot, schema_version: 2 }),
    (error: unknown) => error instanceof Error
      && error.message === 'Unsupported public snapshot schema_version',
  )
})

test('snapshot object key is exact and content-addressed', async () => {
  const snapshot: PublicSnapshotV1 = await buildPublicSnapshot({
    collections: [collectionItem(1, 1)],
    calendar,
  }, 9)

  assert.equal(
    snapshotObjectKey(snapshot),
    `snapshots/v1/9-${snapshot.content_hash}.json`,
  )
})
