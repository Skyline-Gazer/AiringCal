import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSubjectRefreshAt } from '@airing-cal/storage'
import {
  planSubjectRefresh,
  selectRefreshCandidates,
  type RefreshCandidate,
  type RefreshPlannerInput,
  type RefreshPriority,
} from './refresh-planner.ts'

const input: RefreshPlannerInput = {
  subject_id: 42,
  title: 'Planner subject',
  hot: true,
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

test('refresh planner classifies due collection and calendar subjects as hot and cold', () => {
  const cachedAt = 1_000
  const now = nextSubjectRefreshAt(input.subject_id, cachedAt)

  assert.equal(planSubjectRefresh(input, completeCached(cachedAt), now)?.priority, 'hot')
  assert.equal(planSubjectRefresh({ ...input, hot: false }, completeCached(cachedAt), now)?.priority, 'cold')
})

test('refresh planner classifies an incomplete previous refresh as retry', () => {
  const cachedAt = 1_000
  const cached = completeCached(cachedAt)
  cached.refresh.status = 'failed'

  const planned = planSubjectRefresh(input, cached, cachedAt + 1)
  assert.equal(planned?.priority, 'retry')
  assert.deepEqual(planned?.components, ['detail', 'meta', 'image_common', 'image_large'])
})

function candidate(subjectId: number, priority: RefreshPriority): RefreshCandidate {
  return {
    subject_id: subjectId,
    title: `Subject ${subjectId}`,
    components: ['detail'],
    priority,
  }
}

test('refresh planner orders hot before the current cold shard before retry', () => {
  const selection = selectRefreshCandidates([
    candidate(14, 'retry'),
    candidate(10, 'cold'),
    candidate(8, 'hot'),
    candidate(7, 'new_or_changed'),
  ], '2026-07-22', { soft: 50, hard: 100 })

  assert.deepEqual(selection.selected.map(({ subject_id }) => subject_id), [7, 8, 10, 14])
  assert.deepEqual(selection.by_priority, { new_or_changed: 1, hot: 1, cold: 1, retry: 1 })
})

test('refresh planner uses subject id modulo seven for deterministic cold membership', () => {
  const selection = selectRefreshCandidates([
    candidate(3, 'cold'),
    candidate(4, 'cold'),
    candidate(10, 'cold'),
  ], '2026-07-22', { soft: 50, hard: 100 })

  assert.deepEqual(selection.selected.map(({ subject_id }) => subject_id), [3, 10])
  assert.equal(selection.candidates, 2)
  assert.equal(selection.deferred, 0)
})

test('refresh planner limits eighty ordinary candidates to the soft limit of fifty', () => {
  const selection = selectRefreshCandidates(
    Array.from({ length: 80 }, (_, index) => candidate(index + 1, 'hot')),
    '2026-07-22',
    { soft: 50, hard: 100 },
  )

  assert.equal(selection.selected.length, 50)
  assert.equal(selection.candidates, 80)
  assert.equal(selection.deferred, 30)
})

test('refresh planner lets only new or changed candidates cross soft up to hard', () => {
  const sixty = selectRefreshCandidates(
    Array.from({ length: 60 }, (_, index) => candidate(index + 1, 'new_or_changed')),
    '2026-07-22',
    { soft: 50, hard: 100 },
  )
  const oneHundredOne = selectRefreshCandidates(
    Array.from({ length: 101 }, (_, index) => candidate(index + 1, 'new_or_changed')),
    '2026-07-22',
    { soft: 50, hard: 100 },
  )

  assert.equal(sixty.selected.length, 60)
  assert.equal(sixty.deferred, 0)
  assert.equal(oneHundredOne.selected.length, 100)
  assert.equal(oneHundredOne.deferred, 1)
})
