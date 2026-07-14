import assert from 'node:assert/strict'
import test from 'node:test'
import { imageRef, imageRefsFromStatus, subjectDetailImages, subjectMetaFromDetail, transformCalendar, withSubjectDetail } from './index.ts'
import type { BgmCalendarSubjectLike } from './index.ts'

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

test('transformCalendar maps legacy calendar eps_count into public episode totals', () => {
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
          eps_count: 13,
          images: { large: '', common: '', medium: '', small: '', grid: '' },
          rating: { score: 0, rank: 0, total: 0 },
        },
      ],
    },
  ])

  assert.equal(calendar[0]?.items[0]?.eps, 13)
  assert.equal(calendar[0]?.items[0]?.total_episodes, 13)
})

test('subject detail projections use full subject response as canonical source', () => {
  const detail = {
    id: 23080,
    type: 2,
    name: 'Full name',
    name_cn: 'Full CN',
    summary: 'Full summary',
    nsfw: true,
    date: '2026-07-02',
    eps: 12,
    eps_count: 13,
    total_episodes: 24,
    images: {
      common: 'https://img.example/detail-common.jpg',
      large: 'https://img.example/detail-large.jpg',
      medium: 'https://img.example/detail-medium.jpg',
    },
    rating: { score: 8.2, rank: 100, total: 500 },
  }

  assert.deepEqual(subjectDetailImages(detail), {
    common: 'https://img.example/detail-common.jpg',
    large: 'https://img.example/detail-large.jpg',
  })
  assert.deepEqual(subjectMetaFromDetail(23080, detail, 1783000000), {
    subject_id: 23080,
    exists: true,
    nsfw: true,
    checked_at: 1783000000,
    reason: 'subject_detail',
  })

  const calendarSubject: BgmCalendarSubjectLike = {
    id: 23080,
    type: 2,
    name: 'Calendar name',
    name_cn: 'Calendar CN',
    summary: 'Calendar summary',
    nsfw: false,
    date: '2026-07-01',
    eps_count: 1,
    images: { common: 'https://img.example/calendar-common.jpg', large: 'https://img.example/calendar-large.jpg' },
  }
  const merged = withSubjectDetail(calendarSubject, detail)

  assert.equal(merged.name, 'Full name')
  assert.equal(merged.total_episodes, 24)
  assert.equal(merged.images?.common, 'https://img.example/detail-common.jpg')
})
