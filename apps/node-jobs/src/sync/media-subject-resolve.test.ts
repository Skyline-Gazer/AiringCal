import assert from 'node:assert/strict'
import test from 'node:test'
import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import { enrichMediaSubjectsFromFetch } from './media-subject-resolve.ts'

test('enrich fetches detail when only calendar-sized common URL is present', async () => {
  const input = {
    collections: [],
    calendar: [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月', id: 1 },
      items: [{
        id: 390200,
        type: 2,
        name: 'Test',
        name_cn: '',
        nsfw: false,
        images: { common: 'http://lain.bgm.tv/pic/cover/c/xx.jpg' },
      }],
    }],
    observedAt: 1,
    observedUsers: [],
    complete: true,
  } as unknown as CompleteFullFetch

  let fetched = 0
  const subjects = await enrichMediaSubjectsFromFetch(input, {
    fetchSubjectDetail: async () => {
      fetched += 1
      return { large: 'https://lain.bgm.tv/pic/cover/l/better.jpg' }
    },
  })

  assert.equal(fetched, 1)
  assert.equal(subjects[0]?.images.large, 'https://lain.bgm.tv/pic/cover/l/better.jpg')
})

test('enrich skips detail when large URL already present', async () => {
  const input = {
    collections: [],
    calendar: [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月', id: 1 },
      items: [{
        id: 1,
        type: 2,
        name: 'Test',
        name_cn: '',
        nsfw: false,
        images: {
          common: 'https://lain.bgm.tv/pic/cover/c/x.jpg',
          large: 'https://lain.bgm.tv/pic/cover/l/x.jpg',
        },
      }],
    }],
    observedAt: 1,
    observedUsers: [],
    complete: true,
  } as unknown as CompleteFullFetch

  let fetched = 0
  await enrichMediaSubjectsFromFetch(input, {
    fetchSubjectDetail: async () => {
      fetched += 1
      return null
    },
  })
  assert.equal(fetched, 0)
})
