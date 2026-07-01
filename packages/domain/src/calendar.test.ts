import assert from 'node:assert/strict'
import test from 'node:test'
import { imageRef, imageRefsFromStatus, transformCalendar } from './index.ts'

test('imageRefsFromStatus converts cached image status to public refs only', () => {
  assert.deepEqual(imageRefsFromStatus({
    common: { status: 'cached', hash: 'a'.repeat(64), uri: `/image/${'a'.repeat(64)}`, r2_key: `images/${'a'.repeat(64)}/original` },
    large: { status: 'failed', hash: 'b'.repeat(64), uri: `/image/${'b'.repeat(64)}`, r2_key: `images/${'b'.repeat(64)}/original` },
  }), {
    common: imageRef('a'.repeat(64)),
    large: null,
  })
})

test('transformCalendar enriches calendar subjects with image refs and NSFW metadata', () => {
  const calendar = transformCalendar([
    {
      weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
      items: [
        {
          id: 23080,
          type: 2,
          name: 'A',
          name_cn: 'A CN',
          summary: '',
          nsfw: false,
          date: '2026-07-01',
          eps: 12,
          total_episodes: 12,
          images: { large: '', common: '', medium: '', small: '', grid: '' },
          rating: { score: 0, rank: 0, total: 0 },
        },
      ],
    },
  ], new Map([[23080, { common: imageRef('c'.repeat(64)), large: null }]]), new Map([[23080, { nsfw: true }]]))

  assert.equal(calendar[0]?.items[0]?.subject_id, 23080)
  assert.equal(calendar[0]?.items[0]?.images.common?.hash, 'c'.repeat(64))
  assert.equal(calendar[0]?.items[0]?.images.large, null)
  assert.equal(calendar[0]?.items[0]?.nsfw, true)
})
