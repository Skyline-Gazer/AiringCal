import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { projectPublicSnapshotInput } from './project-public-snapshot.ts'

test('projectPublicSnapshotInput matches node-jobs publish path semantics', () => {
  const input = assembleFullFetch(
    [{
      user_id: '1',
      pageLimit: 50,
      pages: [{
        offset: 0,
        total: 1,
        data: [{
          subject_id: 100,
          subject_type: 2,
          rate: 8,
          type: 3,
          private: false,
          comment: '',
          tags: 'daily',
          subject: {
            id: 100,
            type: 2,
            name: 'Test',
            name_cn: '测试',
            summary: 's',
            eps: 12,
            total_episodes: 12,
            date: '2026-01-01',
            images: { common: '/img/common.jpg', large: '' },
            nsfw: false,
            rating: { score: 7, rank: 1, total: 10 },
          },
        }],
      }],
    }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
  const projected = projectPublicSnapshotInput(input)
  assert.equal(projected.collections.length, 1)
  assert.equal(projected.collections[0]?.subject_id, 100)
  assert.equal(projected.collections[0]?.image_status.common, 'missing_source')
  assert.equal(projected.published_at, 1_700_000_000)
  assert.equal(projected.calendar.length, 1)
})
