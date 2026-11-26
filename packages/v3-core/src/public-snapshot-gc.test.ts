import assert from 'node:assert/strict'
import test from 'node:test'
import { planPublicSnapshotGc } from './public-snapshot-gc.ts'

const keys = [
  'snapshots/v1/1-aaa.json',
  'snapshots/v1/2-bbb.json',
  'snapshots/v1/3-ccc.json',
  'snapshots/v1/4-ddd.json',
  'snapshots/v1/5-eee.json',
  'snapshots/v1/6-fff.json',
  'public/manifest.json',
]

test('planPublicSnapshotGc keeps current, pins, and newest N generations', () => {
  const plan = planPublicSnapshotGc({
    snapshotKeys: keys,
    currentArtifactRef: 'snapshots/v1/2-bbb.json',
    pinnedArtifactRefs: new Set(['snapshots/v1/1-aaa.json']),
    minGenerations: 3,
  })
  assert.deepEqual(plan.keep, [
    'snapshots/v1/1-aaa.json',
    'snapshots/v1/2-bbb.json',
    'snapshots/v1/4-ddd.json',
    'snapshots/v1/5-eee.json',
    'snapshots/v1/6-fff.json',
  ])
  assert.deepEqual(plan.delete, ['snapshots/v1/3-ccc.json'])
})

test('planPublicSnapshotGc retains snapshots within minAgeDays', () => {
  const now = 1_000_000
  const plan = planPublicSnapshotGc({
    snapshotKeys: keys,
    currentArtifactRef: 'snapshots/v1/6-fff.json',
    minGenerations: 1,
    minAgeDays: 30,
    nowUnix: now,
    publishedAtUnixByKey: new Map([
      ['snapshots/v1/1-aaa.json', now - 10 * 86_400],
      ['snapshots/v1/2-bbb.json', now - 40 * 86_400],
    ]),
  })
  assert.ok(plan.keep.includes('snapshots/v1/1-aaa.json'))
  assert.ok(!plan.keep.includes('snapshots/v1/2-bbb.json'))
})

test('planPublicSnapshotGc retains rollback candidates below the current pointer (C9)', () => {
  const plan = planPublicSnapshotGc({
    snapshotKeys: keys,
    currentArtifactRef: 'snapshots/v1/6-fff.json',
    minGenerations: 1,
    minAgeDays: 0,
    rollbackGenerations: 2,
  })
  // Default N=2: the two newest generations strictly below the pointer survive
  // even when minGenerations=1 and everything is older than minAgeDays.
  assert.ok(plan.keep.includes('snapshots/v1/5-eee.json'))
  assert.ok(plan.keep.includes('snapshots/v1/4-ddd.json'))
  assert.ok(!plan.keep.includes('snapshots/v1/3-ccc.json'))
})

test('planPublicSnapshotGc rollback candidates are relative to the current generation, not the newest', () => {
  // Generation 2 is current; a rolled-back store can hold abandoned newer
  // generations (3..6). Rollback candidates must be 1 (below current), never
  // the abandoned newer ones.
  const plan = planPublicSnapshotGc({
    snapshotKeys: keys,
    currentArtifactRef: 'snapshots/v1/2-bbb.json',
    minGenerations: 0,
    minAgeDays: 0,
    rollbackGenerations: 2,
  })
  assert.ok(plan.keep.includes('snapshots/v1/1-aaa.json'))
  for (const abandoned of ['snapshots/v1/3-ccc.json', 'snapshots/v1/4-ddd.json', 'snapshots/v1/5-eee.json', 'snapshots/v1/6-fff.json']) {
    assert.ok(!plan.keep.includes(abandoned), `${abandoned} must be collectable`)
  }
})
