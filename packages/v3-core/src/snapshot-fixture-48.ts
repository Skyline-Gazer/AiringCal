import { buildPublicSnapshot } from '@airing-cal/domain'
import type { PublicCollectionItemV1, PublicSnapshotV1 } from '@airing-cal/storage'

const hash = 'b'.repeat(64)

export function build48ItemCollectionFixture(): PublicCollectionItemV1[] {
  return Array.from({ length: 48 }, (_, index) => ({
    subject_id: 20_000 + index,
    name: `Subject ${20_000 + index}`,
    name_cn: `条目 ${20_000 + index}`,
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
    collection_type: (((index % 5) + 1) as 1 | 2 | 3 | 4 | 5),
    rate: 8,
    nsfw: false,
    date: '2026-07-27',
    tags: ['daily', 'fixture'],
    updated_at: '2026-07-27T00:00:00Z',
    rating: { score: 8.1, rank: 12, total: 340 },
  }))
}

export async function build48ItemPublicSnapshotFixture(): Promise<PublicSnapshotV1> {
  const collections = build48ItemCollectionFixture()
  return buildPublicSnapshot({
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
}
