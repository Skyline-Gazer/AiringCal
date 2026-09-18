import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSubjectRefreshAt } from '@airing-cal/storage'
import {
  planSubjectRefresh,
  positiveMod,
  selectRefreshCandidates,
  type RefreshCandidate,
  type RefreshPlannerInput,
  type RefreshPriority,
} from './refresh-planner.ts'

test('positiveMod maps negative subject IDs into the seven valid shards', () => {
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => positiveMod(index - 7, 7)), [0, 1, 2, 3, 4, 5, 6])
  assert.throws(() => positiveMod(1, 0), /positive integer/)
})

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

test('refresh planner keeps a failed image refresh at retry priority', () => {
  const cachedAt = 1_000
  const cached = completeCached(cachedAt)
  cached.refresh.status = 'failed'
  cached.image.common.status = 'failed'

  const planned = planSubjectRefresh(input, cached, cachedAt + 1)
  assert.equal(planned?.priority, 'retry')
  assert.deepEqual(planned?.components, ['detail', 'meta', 'image_common', 'image_large'])
})

test('refresh planner keeps failed or partial work with a real source change at new-or-changed priority', () => {
  for (const status of ['failed', 'partial']) {
    const cachedAt = 1_000
    const cached = completeCached(cachedAt)
    cached.refresh.status = status
    cached.image.common.status = 'failed'
    cached.image.common.source_url = 'https://images.example/42/old-common.jpg'

    const planned = planSubjectRefresh(input, cached, cachedAt + 1)
    assert.equal(planned?.priority, 'new_or_changed')
    assert.deepEqual(planned?.components, ['image_common'])
  }
})

test('refresh planner detects a failed image source change from cached detail when failure state omitted the URL', () => {
  const cachedAt = 1_000
  const cached = completeCached(cachedAt)
  cached.refresh.status = 'partial'
  cached.detail.subject = {
    id: input.subject_id,
    images: {
      common: 'https://images.example/42/old-common.jpg',
      large: input.images?.large,
    },
  } as any
  cached.image.common = { status: 'failed' } as any

  const planned = planSubjectRefresh(input, cached, cachedAt + 1)
  assert.equal(planned?.priority, 'new_or_changed')
  assert.deepEqual(planned?.components, ['image_common'])
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

test('refresh planner assigns every cold residue exactly once across seven UTC days', () => {
  const coldCandidates = Array.from({ length: 7 }, (_, subjectId) => candidate(subjectId, 'cold'))
  const selectedByDay = Array.from({ length: 7 }, (_, dayOffset) => {
    const utcDay = new Date(Date.UTC(2026, 6, 19 + dayOffset)).toISOString().slice(0, 10)
    return selectRefreshCandidates(coldCandidates, utcDay, { soft: 50, hard: 100 })
      .selected.map(({ subject_id }) => subject_id)
  })

  assert.equal(selectedByDay.every((subjectIds) => subjectIds.length === 1), true)
  assert.deepEqual(selectedByDay.flat().sort((left, right) => left - right), [0, 1, 2, 3, 4, 5, 6])
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

test('refresh planner lets new or changed candidates cross soft without carrying ordinary candidates with them', () => {
  const selection = selectRefreshCandidates([
    ...Array.from({ length: 60 }, (_, index) => candidate(index + 1, 'new_or_changed')),
    ...Array.from({ length: 40 }, (_, index) => candidate(index + 101, 'hot')),
  ], '2026-07-22', { soft: 50, hard: 100 })

  assert.equal(selection.selected.length, 60)
  assert.equal(selection.selected.every(({ priority }) => priority === 'new_or_changed'), true)
  assert.equal(selection.deferred, 40)
})

test('refresh planner deduplicates a subject and merges components at its strongest priority', () => {
  const selection = selectRefreshCandidates([
    { ...candidate(7, 'retry'), components: ['detail'] },
    { ...candidate(7, 'new_or_changed'), components: ['image_common'] },
    { ...candidate(7, 'hot'), components: ['meta'] },
  ], '2026-07-22', { soft: 50, hard: 100 })

  assert.equal(selection.selected.length, 1)
  assert.equal(selection.selected[0]?.priority, 'new_or_changed')
  assert.deepEqual(selection.selected[0]?.components, ['detail', 'meta', 'image_common'])
})

test('persisted deferred cold cursor resumes IDs before the current day shard', () => {
  const first = selectRefreshCandidates(
    Array.from({ length: 60 }, (_, index) => candidate(index * 7 + 3, 'cold')),
    '2026-07-22',
    { soft: 50, hard: 100 },
  )
  assert.equal(first.selected.length, 50)
  assert.deepEqual(first.cold_cursor.subject_ids, Array.from({ length: 10 }, (_, index) => (index + 50) * 7 + 3))

  const resumed = selectRefreshCandidates(
    [
      ...first.cold_cursor.subject_ids.map((subjectId) => candidate(subjectId, 'cold')),
      candidate(4, 'cold'),
    ],
    '2026-07-23',
    { soft: 50, hard: 100 },
    first.cold_cursor,
  )
  assert.deepEqual(resumed.selected.map(({ subject_id }) => subject_id), [...first.cold_cursor.subject_ids, 4])
  assert.deepEqual(resumed.cold_cursor.subject_ids, [])
})

test('budget exhaustion preserves deferred order across hot cold and retry', () => {
  const selection = selectRefreshCandidates([
    ...Array.from({ length: 49 }, (_, index) => candidate(index + 100, 'new_or_changed')),
    candidate(1, 'hot'),
    candidate(3, 'cold'),
    candidate(2, 'retry'),
  ], '2026-07-22', { soft: 50, hard: 50 })

  assert.deepEqual(selection.selected.slice(-1).map(({ subject_id }) => subject_id), [1])
  assert.deepEqual(selection.deferred_candidates.map(({ priority }) => priority), ['cold', 'retry'])
  assert.deepEqual(selection.cold_cursor.subject_ids, [3])
})
