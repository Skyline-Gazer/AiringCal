import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PublicCalendarDayV1,
  PublicCollectionItemV1,
  PublicSnapshotSummaryV1,
  PublicSnapshotV1,
} from './d1-types.ts'
import {
  buildLegacyPublicResult,
  compareShadowSnapshots,
  normalizePublicResult,
} from './shadow-compare.ts'

const imageRef = { hash: 'h', uri: '/image/h', r2_key: 'images/h/original' }

function item(subjectId: number, name: string): PublicCollectionItemV1 {
  return {
    subject_id: subjectId,
    name,
    name_cn: '',
    summary: '',
    images: { common: imageRef, large: null },
    image_status: { common: 'cached', large: 'pending_next_cron' },
    eps: 1,
    total_episodes: 12,
    ep_status: 1,
    vol_status: 0,
    type: 2,
    collection_type: 2,
    rate: 0,
    nsfw: false,
    date: '2026-07-31',
    tags: [],
    updated_at: '2026-07-31T00:00:00.000Z',
  }
}

function calendarDay(weekdayId: number): PublicCalendarDayV1 {
  return {
    weekday: { en: 'Mon', cn: '星期一', ja: '月耀日', id: weekdayId },
    items: [],
  }
}

function summary(): PublicSnapshotSummaryV1 {
  return { want: 0, watched: 1, watching: 0, on_hold: 0, dropped: 0, _total: 1 }
}

function snapshot(generation: number): PublicSnapshotV1 {
  return {
    schema_version: 1,
    generation,
    content_hash: 'c'.repeat(64),
    published_at: 1_000 + generation,
    collections: {
      want: [],
      watched: [item(2, 'B'), item(1, 'A')],
      watching: [],
      on_hold: [],
      dropped: [],
    },
    calendar: [calendarDay(2), calendarDay(1)],
    summary: summary(),
  }
}

test('generation and publish-time-only differences compare equal', () => {
  const left = normalizePublicResult(snapshot(1))
  const right = normalizePublicResult(snapshot(2))

  const result = compareShadowSnapshots(left, right)

  assert.equal(result.equal, true)
  assert.deepEqual(result.diffs, [])
})

test('ordering noise is normalized away', () => {
  const a = normalizePublicResult(snapshot(1))
  const b = snapshot(1)
  b.collections.watched = [item(1, 'A'), item(2, 'B')]
  b.calendar = [calendarDay(1), calendarDay(2)]

  const result = compareShadowSnapshots(a, normalizePublicResult(b))

  assert.equal(result.equal, true)
})

test('a business field difference yields a diff path', () => {
  const a = normalizePublicResult(snapshot(1))
  const b = snapshot(1)
  b.collections.watched = [item(2, 'B-changed'), item(1, 'A')]

  const result = compareShadowSnapshots(a, normalizePublicResult(b))

  assert.equal(result.equal, false)
  assert.ok(result.diffs[0]?.includes('collections.watched'))
  assert.ok(result.diffs[0]?.includes('name'))
})

test('coarse image status normalization keeps queued and missing-source legacy states comparable', () => {
  const a = snapshot(1)
  a.collections.watched[0]!.image_status = { common: 'queued', large: 'missing_source' }
  const b = snapshot(1)
  b.collections.watched[0]!.image_status = { common: 'pending_next_cron', large: 'failed' }

  const result = compareShadowSnapshots(normalizePublicResult(a), normalizePublicResult(b))

  assert.equal(result.equal, true)
})

test('a genuine image status transition produces a diff', () => {
  const a = snapshot(1)
  const b = snapshot(1)
  b.collections.watched[0]!.image_status = { common: 'pending_next_cron', large: 'cached' }

  const result = compareShadowSnapshots(normalizePublicResult(a), normalizePublicResult(b))

  assert.equal(result.equal, false)
  assert.ok(result.diffs.some((diff) => diff.includes('image_status')))
})

test('calendar weekday and summary differences yield diffs', () => {
  const a = normalizePublicResult(snapshot(1))
  const b = snapshot(1)
  b.calendar = [calendarDay(3), calendarDay(1)]
  b.summary.watched = 2
  b.summary._total = 2

  const result = compareShadowSnapshots(a, normalizePublicResult(b))

  assert.equal(result.equal, false)
  assert.ok(result.diffs.some((diff) => diff.includes('calendar')))
  assert.ok(result.diffs.some((diff) => diff.includes('summary.watched')))
})

test('hydrated legacy result compares equal to the R2 snapshot projection', () => {
  const hydrated = {
    1: {
      images: { common: imageRef, large: null },
      image_status: { common: 'cached', large: 'pending_next_cron' },
      nsfw: true,
      eps: 3,
      total_episodes: 24,
    },
    2: {
      images: { common: imageRef, large: null },
      image_status: { common: 'cached', large: 'pending_next_cron' },
      nsfw: false,
      eps: 1,
      total_episodes: 12,
    },
  }
  const legacy = {
    collections: {
      want: [],
      watched: [item(1, 'A'), item(2, 'B')],
      watching: [],
      on_hold: [],
      dropped: [],
    },
    calendar: [calendarDay(1), calendarDay(2)],
    summary: summary(),
  }

  const legacyNormalized = buildLegacyPublicResult(legacy, hydrated)
  const r2 = snapshot(1)
  r2.collections.watched[0] = { ...item(1, 'A'), nsfw: true, eps: 3, total_episodes: 24 }
  r2.collections.watched[1] = { ...item(2, 'B'), nsfw: false }
  const result = compareShadowSnapshots(legacyNormalized, normalizePublicResult(r2))

  assert.equal(result.equal, true)
})
