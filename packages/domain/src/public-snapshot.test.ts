import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PublicCalendarDayV1,
  PublicCollectionItemV1,
  PublicSnapshotV1,
} from '@airing-cal/storage'
import { sha256Canonical } from '@airing-cal/storage'
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
    published_at: 1_722_000_000,
  }, 41)

  assert.equal(snapshot.schema_version, 1)
  assert.equal(snapshot.generation, 41)
  assert.equal(snapshot.published_at, 1_722_000_000)
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
  assert.equal(first.published_at, 100)
  assert.equal(second.published_at, 999)
})

test('snapshot parser round-trips the known schema and rejects unknown schema precisely', async () => {
  const snapshot = await buildPublicSnapshot({
    collections: [collectionItem(1, 1)],
    calendar,
    published_at: 100,
  }, 3)

  assert.deepEqual(await parsePublicSnapshotV1(JSON.parse(JSON.stringify(snapshot))), snapshot)
  await assert.rejects(
    parsePublicSnapshotV1({ ...snapshot, schema_version: 2 }),
    (error: unknown) => error instanceof Error
      && error.message === 'Unsupported public snapshot schema_version',
  )
})

test('snapshot parser deeply rejects malformed nested fields, counters and envelope values', async () => {
  const snapshot = await buildPublicSnapshot({
    collections: [collectionItem(1, 1)],
    calendar,
    published_at: 100,
  }, 3)
  const invalidValues: unknown[] = [
    { ...snapshot, generation: -1 },
    { ...snapshot, generation: 1.5 },
    { ...snapshot, published_at: -1 },
    { ...snapshot, published_at: 1.5 },
    { ...snapshot, content_hash: 'A'.repeat(64) },
    { ...snapshot, content_hash: 'a'.repeat(63) },
    { ...snapshot, collections: { ...snapshot.collections, want: [{}] } },
    { ...snapshot, collections: { ...snapshot.collections, want: [{ ...snapshot.collections.want[0], nsfw: 1 }] } },
    { ...snapshot, collections: { ...snapshot.collections, want: [{ ...snapshot.collections.want[0], images: { common: {}, large: null } }] } },
    { ...snapshot, calendar: [{ ...snapshot.calendar[0], weekday: { ...snapshot.calendar[0]?.weekday, id: '7' } }] },
    { ...snapshot, calendar: [{ ...snapshot.calendar[0], items: [{ ...snapshot.calendar[0]?.items[0], nsfw: 'yes' }] }] },
    { ...snapshot, summary: { ...snapshot.summary, want: 2, _total: 2 } },
  ]

  for (const value of invalidValues) {
    await assert.rejects(parsePublicSnapshotV1(value), /Invalid public snapshot/)
  }
})

test('snapshot parser rejects a structurally valid payload whose content hash is stale', async () => {
  const snapshot = await buildPublicSnapshot({
    collections: [collectionItem(1, 1)],
    calendar,
    published_at: 100,
  }, 3)
  const changed = structuredClone(snapshot)
  changed.collections.want[0]!.name = 'Tampered'

  await assert.rejects(parsePublicSnapshotV1(changed), /Invalid public snapshot content_hash/)
})

test('buildPublicSnapshot rejects unknown collection types', async () => {
  await assert.rejects(
    buildPublicSnapshot({
      collections: [collectionItem(1, 99)],
      calendar,
      published_at: 100,
    }, 1),
    /Unsupported collection_type: 99/,
  )
})

test('buildPublicSnapshot rejects invalid generation and publication timestamps', async () => {
  const input = {
    collections: [collectionItem(1, 1)],
    calendar,
    published_at: 100,
  }
  await assert.rejects(buildPublicSnapshot(input, -1), /Invalid snapshot generation/)
  await assert.rejects(buildPublicSnapshot({ ...input, published_at: 1.5 }, 1), /Invalid snapshot published_at/)
})

test('buildPublicSnapshot rejects typed inputs that violate the shared public snapshot semantics', async () => {
  const invalidInputs = [
    {
      collections: [collectionItem(1, 1, { rate: -1 })],
      calendar,
      published_at: 100,
    },
    {
      collections: [collectionItem(1, 1, {
        images: {
          common: { hash: 'invalid', uri: '/image/invalid', r2_key: 'images/invalid/original' },
          large: null,
        },
      })],
      calendar,
      published_at: 100,
    },
    {
      collections: [collectionItem(1, 1)],
      calendar: [{
        ...calendar[0]!,
        items: [{ ...calendar[0]!.items[0]!, subject_id: 999 }],
      }],
      published_at: 100,
    },
  ]

  for (const input of invalidInputs) {
    await assert.rejects(buildPublicSnapshot(input, 1), /Invalid public snapshot/)
  }
})

test('every snapshot returned by the builder asynchronously round-trips through the parser', async () => {
  for (const generation of [0, 1, 99]) {
    const snapshot = await buildPublicSnapshot({
      collections: [
        collectionItem(generation + 1, 1),
        collectionItem(generation + 101, 3, { nsfw: true }),
      ],
      calendar,
      published_at: generation,
    }, generation)

    assert.deepEqual(await parsePublicSnapshotV1(structuredClone(snapshot)), snapshot)
  }
})

test('snapshot parser enforces collection bucket and calendar identity invariants', async () => {
  const snapshot = await buildPublicSnapshot({
    collections: [collectionItem(1, 1)],
    calendar,
    published_at: 100,
  }, 1)
  const wrongBucket = structuredClone(snapshot)
  wrongBucket.collections.watched = wrongBucket.collections.want
  wrongBucket.collections.want = []
  wrongBucket.summary = { want: 0, watched: 1, watching: 0, on_hold: 0, dropped: 0, _total: 1 }
  wrongBucket.content_hash = await sha256Canonical({
    schema_version: 1,
    collections: wrongBucket.collections,
    calendar: wrongBucket.calendar,
    summary: wrongBucket.summary,
  })

  await assert.rejects(parsePublicSnapshotV1(wrongBucket), /Invalid public snapshot/)

  const wrongCalendarIdentity = structuredClone(snapshot)
  wrongCalendarIdentity.calendar[0]!.items[0]!.subject_id = 999
  wrongCalendarIdentity.content_hash = await sha256Canonical({
    schema_version: 1,
    collections: wrongCalendarIdentity.collections,
    calendar: wrongCalendarIdentity.calendar,
    summary: wrongCalendarIdentity.summary,
  })
  await assert.rejects(parsePublicSnapshotV1(wrongCalendarIdentity), /Invalid public snapshot/)
})

test('snapshot object key is exact and content-addressed', async () => {
  const snapshot: PublicSnapshotV1 = await buildPublicSnapshot({
    collections: [collectionItem(1, 1)],
    calendar,
    published_at: 100,
  }, 9)

  assert.equal(
    snapshotObjectKey(snapshot),
    `snapshots/v1/9-${snapshot.content_hash}.json`,
  )
})
