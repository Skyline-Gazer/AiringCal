import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSubjectRefreshAt } from '@airing-cal/storage'
import { planSubjectRefresh, type RefreshPlannerInput } from './refresh-planner.ts'

const input: RefreshPlannerInput = {
  subject_id: 42,
  title: 'Planner subject',
  images: {
    common: 'https://images.example/42/common.jpg',
    large: 'https://images.example/42/large.jpg',
  },
}

function completeCached(cachedAt: number) {
  return {
    detail: { cached_at: cachedAt, subject: { id: input.subject_id } },
    meta: { subject_id: input.subject_id, exists: true, checked_at: cachedAt, reason: 'subject_detail' as const },
    image: {
      common: { status: 'cached', source_url: input.images?.common },
      large: { status: 'cached', source_url: input.images?.large },
    },
    refresh: { subject_id: input.subject_id, status: 'ok', updated_at: cachedAt },
  }
}

test('complete and unexpired subject has no refresh candidate', () => {
  const cachedAt = 1_000

  assert.equal(planSubjectRefresh(input, completeCached(cachedAt), nextSubjectRefreshAt(input.subject_id, cachedAt) - 1), null)
})

test('missing detail schedules detail and meta', () => {
  const cachedAt = 1_000
  const cached = completeCached(cachedAt)
  cached.detail = null as any

  assert.deepEqual(planSubjectRefresh(input, cached, cachedAt + 1)?.components, ['detail', 'meta'])
})

test('changed image source schedules only that image component', () => {
  const cachedAt = 1_000
  const cached = completeCached(cachedAt)
  cached.image.common.source_url = 'https://images.example/42/old-common.jpg'

  assert.deepEqual(planSubjectRefresh(input, cached, cachedAt + 1)?.components, ['image_common'])
})

test('the exact next subject refresh boundary is due', () => {
  const cachedAt = 1_000

  assert.deepEqual(
    planSubjectRefresh(input, completeCached(cachedAt), nextSubjectRefreshAt(input.subject_id, cachedAt))?.components,
    ['detail', 'meta', 'image_common', 'image_large'],
  )
})
