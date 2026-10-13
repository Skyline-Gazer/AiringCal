import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { createRunContext } from '../adapters/run-context.ts'
import { bangumiImageUrl, coalesceSubjectImageUrls, mediaSubjectsFromFetch } from './media-refresh.ts'
import { createEnrichMediaSubjectsFromFetch, enrichMediaSubjectsFromFetch } from './media-subject-resolve.ts'

const COMMON_URL = 'https://lain.bgm.tv/pic/cover/c/common.jpg'
const LARGE_URL = 'https://lain.bgm.tv/pic/cover/l/large.jpg'
const GRID_URL = 'https://lain.bgm.tv/pic/cover/g/grid.jpg'

test('coalesceSubjectImageUrls maps grid/medium to common when common missing', () => {
  assert.deepEqual(coalesceSubjectImageUrls({ grid: GRID_URL }), { common: GRID_URL })
  assert.deepEqual(
    coalesceSubjectImageUrls({ grid: GRID_URL, large: LARGE_URL }),
    { common: GRID_URL, large: LARGE_URL },
  )
})

test('mediaSubjectsFromFetch coalesces calendar grid into common for media queue', () => {
  const input = assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{
      weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 },
      items: [{ id: 390200, type: 2, name: 'Cal', images: { grid: GRID_URL } }],
    }],
    1_700_000_000,
  )
  const subjects = mediaSubjectsFromFetch(input)
  assert.equal(subjects.length, 1)
  assert.equal(subjects[0]?.subjectId, 390200)
  assert.equal(bangumiImageUrl(subjects[0]?.images.common), GRID_URL)
})

test('enrichMediaSubjectsFromFetch fills missing images via subject detail', async () => {
  const input = assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{
      weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 },
      items: [{ id: 99, type: 2, name: 'Cal-only' }],
    }],
    1_700_000_000,
  )
  const calls: number[] = []
  const subjects = await enrichMediaSubjectsFromFetch(input, {
    fetchSubjectDetail: async (subjectId) => {
      calls.push(subjectId)
      if (subjectId !== 99) return null
      return { common: COMMON_URL, large: LARGE_URL }
    },
  })
  assert.deepEqual(calls, [99])
  assert.equal(subjects[0]?.images.common, COMMON_URL)
  assert.equal(subjects[0]?.images.large, LARGE_URL)
})

test('createEnrichMediaSubjectsFromFetch respects run guard and signal', async () => {
  const input = assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{
      weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 },
      items: [{ id: 1, type: 2, name: 'A' }, { id: 2, type: 2, name: 'B' }],
    }],
    1_700_000_000,
  )
  const run = createRunContext({ runId: 'run-enrich', deadlineAt: Date.now() + 60_000 })
  const enrich = createEnrichMediaSubjectsFromFetch(async (subjectId) => ({
    common: `https://lain.bgm.tv/pic/cover/c/${subjectId}.jpg`,
  }))
  const subjects = await enrich(input, run)
  assert.equal(subjects.length, 2)
  assert.ok(subjects.every((subject) => bangumiImageUrl(subject.images.common)))
})
