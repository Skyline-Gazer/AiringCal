import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublicSnapshotV1 } from './d1-types.ts'

function inspectStablePublicPayload(snapshot: PublicSnapshotV1) {
  const collection = snapshot.collections.watching[0]
  const calendarSubject = snapshot.calendar[0]?.items[0]

  return {
    collectionId: collection?.subject_id,
    collectionNsfw: collection?.nsfw,
    collectionImage: collection?.images.common?.r2_key,
    calendarId: calendarSubject?.subject_id,
    calendarNsfw: calendarSubject?.nsfw,
    calendarImage: calendarSubject?.images.large?.uri,
    total: snapshot.summary._total,
  }
}

test('PublicSnapshotV1 exposes concrete collection, calendar, summary, image and NSFW projections', () => {
  const snapshot: PublicSnapshotV1 = {
    schema_version: 1,
    generation: 7,
    content_hash: 'sha256:public',
    published_at: 1_722_000_000,
    collections: {
      want: [],
      watched: [],
      watching: [{
        subject_id: 23080,
        name: 'A',
        name_cn: 'A CN',
        summary: '',
        images: {
          common: { hash: 'a'.repeat(64), uri: '/api/images/a', r2_key: 'images/a/original' },
          large: null,
        },
        eps: 12,
        total_episodes: 12,
        ep_status: 3,
        vol_status: 0,
        type: 2,
        collection_type: 3,
        rate: 8,
        nsfw: false,
        date: '2026-07-27',
        tags: ['daily'],
        updated_at: '2026-07-27T00:00:00Z',
      }],
      on_hold: [],
      dropped: [],
    },
    calendar: [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月', id: 1 },
      items: [{
        subject_id: 23080,
        id: 23080,
        type: 2,
        name: 'A',
        name_cn: 'A CN',
        summary: '',
        images: { common: null, large: null },
        nsfw: false,
        date: '2026-07-27',
        eps: 12,
        total_episodes: 12,
      }],
    }],
    summary: { want: 0, watched: 0, watching: 1, on_hold: 0, dropped: 0, _total: 1 },
  }

  assert.deepEqual(inspectStablePublicPayload(snapshot), {
    collectionId: 23080,
    collectionNsfw: false,
    collectionImage: 'images/a/original',
    calendarId: 23080,
    calendarNsfw: false,
    calendarImage: undefined,
    total: 1,
  })
})
