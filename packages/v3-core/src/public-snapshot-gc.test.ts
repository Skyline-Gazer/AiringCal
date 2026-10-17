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
