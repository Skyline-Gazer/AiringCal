import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PublicCollectionItemV1,
  PublicSnapshotSummaryV1,
} from '@airing-cal/storage'
import {
  readLegacyPublicResult,
  runDailyShadowPhase,
  type DailyShadowKv,
  type DailyShadowPhaseDeps,
} from './daily-shadow.ts'

const imageHash = 'c'.repeat(64)
const imageRef = { hash: imageHash, uri: '/image/h1', r2_key: 'images/h1/original' }

function item(subjectId: number): PublicCollectionItemV1 {
  return {
    subject_id: subjectId,
    name: `s${subjectId}`,
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

function summary(): PublicSnapshotSummaryV1 {
  return { want: 0, watched: 2, watching: 0, on_hold: 0, dropped: 0, _total: 2 }
}

class FakeShadowKv implements DailyShadowKv {
  values = new Map<string, unknown>()

  async get(key: string, _type: 'json'): Promise<unknown> {
    return this.values.get(key) ?? null
  }

  async put(_key: string, _value: unknown): Promise<void> {
    // Unused in the comparison path.
  }
}

function seededLegacyKv(): FakeShadowKv {
  const kv = new FakeShadowKv()
  kv.values.set('snapshot:version:live-1:collections:watched', [item(2), item(1)])
  kv.values.set('snapshot:version:live-1:summary', summary())
  kv.values.set('snapshot:version:live-1:calendar', [])
  kv.values.set('image:status:1', {
    common: { status: 'cached', hash: 'h1', uri: '/image/h1', r2_key: 'images/h1/original' },
  })
  kv.values.set('subject:meta:1', {
    subject_id: 1,
    exists: true,
    nsfw: true,
    checked_at: 100,
    expires_at: null,
    reason: 'subject_detail',
  })
  kv.values.set('subject:detail:1', {
    subject: { id: 1, eps: 3, eps_count: 24, total_episodes: 24 },
    rating: { score: 8, rank: 10, total: 100 },
  })
  return kv
}

test('readLegacyPublicResult hydrates images, nsfw, episodes, and rating from legacy KV', async () => {
  const kv = seededLegacyKv()

  const result = await readLegacyPublicResult(kv, 'live-1')

  const watched = result.collections.watched
  assert.equal(watched.length, 2)
  const first = watched.find((entry) => entry.subject_id === 1)
  assert.ok(first)
  assert.equal(first.nsfw, true)
  assert.equal(first.eps, 3)
  assert.equal(first.total_episodes, 24)
  assert.equal(first.images.common?.r2_key, 'images/h1/original')
  assert.deepEqual(first.image_status, { common: 'cached', large: 'pending' })
  const second = watched.find((entry) => entry.subject_id === 2)
  assert.ok(second)
  assert.equal(second.nsfw, false)
  assert.equal(second.eps, 1)
  assert.deepEqual(second.image_status, { common: 'pending', large: 'pending' })
})

test('readLegacyPublicResult falls back to legacy snapshot keys without an active instance', async () => {
  const kv = new FakeShadowKv()
  kv.values.set('snapshot:collections:watched', [item(7)])
  kv.values.set('snapshot:summary', summary())
  kv.values.set('snapshot:calendar', [])

  const result = await readLegacyPublicResult(kv, null)

  assert.equal(result.collections.watched[0]?.subject_id, 7)
})

function happyDeps(): { deps: DailyShadowPhaseDeps; calls: string[] } {
  const calls: string[] = []
  const deps: DailyShadowPhaseDeps = {
    now: 1_000,
    instanceId: 'scheduled-1',
    activeInstance: 'live-1',
    legacySubjectKvWrites: 0,
    runIncremental: async () => {
      calls.push('incremental')
      return {
        publicationInput: {
          collections: [item(1)],
          calendar: [],
          published_at: 1_000,
          content_hash: 'c'.repeat(64),
        },
        rowsWritten: 0,
        firstMissing: 0,
        deleted: 0,
        restored: 0,
        media: { candidates: 0, granted: 0, confirmed: 0, uncertain: 0, deferred: 0 },
        runId: 'scheduled-1:shadow',
      }
    },
    publishShadow: async () => {
      calls.push('publish')
      return { status: 'published', generation: 9, contentHash: 'c'.repeat(64), r2Puts: 1, pointerPuts: 1 }
    },
    legacyResult: async () => {
      calls.push('legacy')
      return { collections: { want: [], watched: [item(1)], watching: [], on_hold: [], dropped: [] }, calendar: [], summary: summary() }
    },
    compare: (legacy, r2) => {
      calls.push('compare')
      return { equal: true, diffs: [] }
    },
    updateStreak: async () => {
      calls.push('streak')
    },
    recordKvBudget: async () => {
      calls.push('budget')
    },
    gatePassed: async () => {
      calls.push('gate')
      return true
    },
    promotePointer: async () => {
      calls.push('promote')
      return { promoted: true, generation: 9 }
    },
    switchMode: async () => {
      calls.push('switch')
    },
    runCleanup: async () => {
      calls.push('cleanup')
    },
    runMigration: async () => {
      calls.push('migration')
    },
  }
  return { deps, calls }
}

test('runDailyShadowPhase promotes, switches, and cleans up when the gate passes', async () => {
  const { deps, calls } = happyDeps()

  const result = await runDailyShadowPhase(deps)

  assert.deepEqual(result.shadow_errors, [])
  assert.deepEqual(calls, [
    'incremental', 'publish', 'migration', 'legacy', 'compare', 'streak', 'budget', 'gate', 'promote', 'switch', 'cleanup',
  ])
})

test('runDailyShadowPhase records errors without switching when the gate fails', async () => {
  const { deps, calls } = happyDeps()
  deps.gatePassed = async () => {
    calls.push('gate')
    return false
  }

  const result = await runDailyShadowPhase(deps)

  assert.deepEqual(result.shadow_errors, [])
  assert.ok(!calls.includes('promote'))
  assert.ok(!calls.includes('switch'))
  assert.ok(calls.includes('cleanup'))
})

test('runDailyShadowPhase captures an incremental failure and skips later stages', async () => {
  const { deps, calls } = happyDeps()
  deps.runIncremental = async () => {
    calls.push('incremental')
    throw new Error('D1 sync failed')
  }

  const result = await runDailyShadowPhase(deps)

  assert.deepEqual(result.shadow_errors, ['incremental: D1 sync failed'])
  assert.ok(!calls.includes('publish'))
  assert.ok(!calls.includes('promote'))
  assert.ok(calls.includes('cleanup'))
})

test('runDailyShadowPhase records a pending shadow publication without blocking migration', async () => {
  const { deps, calls } = happyDeps()
  deps.publishShadow = async () => {
    calls.push('publish')
    return { status: 'pending', generation: 9, contentHash: 'c'.repeat(64), r2Puts: 1, pointerPuts: 0 }
  }

  const result = await runDailyShadowPhase(deps)

  assert.ok(result.shadow_errors.some((message) => message.includes('pending')))
  assert.ok(calls.includes('migration'))
  assert.ok(!calls.includes('promote'))
})
