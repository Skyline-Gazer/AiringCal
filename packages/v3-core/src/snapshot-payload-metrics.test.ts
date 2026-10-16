import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { buildPublicSnapshot } from '@airing-cal/domain'
import type { PublicCollectionItemV1 } from '@airing-cal/storage'

const hash = 'b'.repeat(64)

function collectionItem(subjectId: number, collectionType: 1 | 2 | 3 | 4 | 5): PublicCollectionItemV1 {
  return {
    subject_id: subjectId,
    name: `Subject ${subjectId}`,
    name_cn: `条目 ${subjectId}`,
    summary: 'summary text for payload sizing',
    images: {
      common: { hash, uri: `/image/${hash}`, r2_key: `images/${hash}/original` },
      large: null,
    },
    image_status: { common: 'cached', large: 'pending_next_cron' },
    eps: 12,
    total_episodes: 12,
    ep_status: 2,
    vol_status: 0,
    type: 2,
    collection_type: collectionType,
    rate: 8,
    nsfw: false,
    date: '2026-07-27',
    tags: ['daily', 'fixture'],
    updated_at: '2026-07-27T00:00:00Z',
    rating: { score: 8.1, rank: 12, total: 340 },
  }
}

test('measured fixture snapshot size baseline for split-json decision (#69)', async () => {
  const collections = Array.from({ length: 48 }, (_, index) =>
    collectionItem(20_000 + index, ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5),
  )
  const snapshot = await buildPublicSnapshot({
    collections,
    calendar: [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月', id: 1 },
      items: collections.slice(0, 12).map((item) => ({
        subject_id: item.subject_id,
        id: item.subject_id,
        type: item.type,
        name: item.name,
        name_cn: item.name_cn,
        summary: item.summary,
        images: item.images,
        image_status: item.image_status,
        nsfw: item.nsfw,
        date: item.date,
        eps: item.eps,
        total_episodes: item.total_episodes,
        rating: item.rating,
      })),
    }],
    published_at: 1_722_000_000,
  }, 1)

  const json = JSON.stringify(snapshot)
  const gzipBytes = gzipSync(json)

  assert.ok(json.length > 10_000, 'fixture should be non-trivial')
  assert.ok(gzipBytes.length < json.length, 'gzip should compress JSON snapshot')
  assert.ok(gzipBytes.length < 500_000, '48-item fixture gzip stays under 500KiB — single JSON likely viable')
})
