import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildPublicSnapshot } from '@airing-cal/domain'
import {
  migrateShadowStreakKey,
  type PublicCollectionItemV1,
  type ShadowStreakV1,
} from '@airing-cal/storage'
import { openBuilderDatabase, SqliteBuilderStateStore } from '@airing-cal/v3-builder'
import {
  REQUIRED_SHADOW_MATCHES,
  parseShadowGateArgs,
  resetShadowStreak,
  runShadowGate,
} from './portable-shadow-gate.ts'

function collectionItem(subject_id: number, name: string): PublicCollectionItemV1 {
  return {
    subject_id,
    name,
    name_cn: '',
    summary: '',
    images: { common: null, large: null },
    image_status: { common: 'cached', large: 'pending_next_cron' },
    eps: 12,
    total_episodes: 12,
    ep_status: 0,
    vol_status: 0,
    type: 2,
    collection_type: 3,
    rate: 0,
    nsfw: false,
    date: '2026-10-17',
    tags: [],
    updated_at: '2026-10-17T00:00:00Z',
  }
}

async function snapshotFixture(name = 'Subject 1'): Promise<unknown> {
  return buildPublicSnapshot({
    collections: [collectionItem(1, name)],
    calendar: [],
    published_at: 1_722_000_000,
  }, 1)
}

/** Legacy public result without `schema_version`, as exported from v2 KV. */
function legacyPublicResult(name = 'Subject 1'): unknown {
  return {
    collections: {
      want: [],
      watched: [{ ...collectionItem(1, name) }],
      watching: [],
      on_hold: [],
      dropped: [],
    },
    calendar: [],
    summary: { want: 0, watched: 1, watching: 0, on_hold: 0, dropped: 0, _total: 1 },
  }
}

function tempSqlite(): string {
  return join(mkdtempSync(join(tmpdir(), 'airingcal-shadow-gate-')), 'builder.sqlite')
}

function storedStreak(sqlitePath: string): Promise<ShadowStreakV1> {
  const db = openBuilderDatabase(sqlitePath)
  try {
    return new SqliteBuilderStateStore(db).getKv(migrateShadowStreakKey()).then(
      (raw) => JSON.parse(raw ?? 'null') as ShadowStreakV1,
    )
  } finally {
    db.close()
  }
}

test('shadow gate opens only after seven consecutive matches', async () => {
  const sqlitePath = tempSqlite()
  const candidate = await snapshotFixture()

  for (let run = 1; run <= REQUIRED_SHADOW_MATCHES; run += 1) {
    const result = await runShadowGate({
      sqlitePath,
      legacyPayload: candidate,
      candidatePayload: candidate,
      now: () => 1_700_000_000_000 + run * 1_000,
    })
    assert.equal(result.equal, true, `run ${run} should compare equal`)
    assert.equal(result.streak.streak, run)
    assert.equal(result.cutover_allowed, run >= REQUIRED_SHADOW_MATCHES, `run ${run} gate state`)
  }

  const stored = await storedStreak(sqlitePath)
  assert.equal(stored.streak, REQUIRED_SHADOW_MATCHES)
  assert.equal(stored.last_diff_summary, null)
  assert.equal(stored.last_success_at, 1_700_000_000 + REQUIRED_SHADOW_MATCHES)
})

test('shadow gate resets the streak and stores the diff summary on a mismatch', async () => {
  const sqlitePath = tempSqlite()
  const candidate = await snapshotFixture()

  await runShadowGate({ sqlitePath, legacyPayload: candidate, candidatePayload: candidate })
  await runShadowGate({ sqlitePath, legacyPayload: candidate, candidatePayload: candidate })

  const mismatch = await runShadowGate({
    sqlitePath,
    legacyPayload: candidate,
    candidatePayload: await snapshotFixture('Renamed subject'),
  })
  assert.equal(mismatch.equal, false)
  assert.equal(mismatch.streak.streak, 0)
  assert.equal(mismatch.cutover_allowed, false)
  assert.ok(mismatch.diff_count > 0)
  assert.ok(mismatch.streak.last_diff_summary?.includes('Renamed subject'))

  const recovered = await runShadowGate({ sqlitePath, legacyPayload: candidate, candidatePayload: candidate })
  assert.equal(recovered.streak.streak, 1, 'the streak restarts after a mismatch')
})

test('shadow gate ignores a corrupt streak record and reset clears it', async () => {
  const sqlitePath = tempSqlite()
  const candidate = await snapshotFixture()

  const db = openBuilderDatabase(sqlitePath)
  try {
    await new SqliteBuilderStateStore(db).setKv(migrateShadowStreakKey(), '{"streak":"lots"}')
  } finally {
    db.close()
  }
  const result = await runShadowGate({ sqlitePath, legacyPayload: candidate, candidatePayload: candidate })
  assert.equal(result.streak.streak, 1, 'a corrupt streak restarts counting instead of being trusted')

  await resetShadowStreak(sqlitePath)
  const afterReset = await runShadowGate({ sqlitePath, legacyPayload: candidate, candidatePayload: candidate })
  assert.equal(afterReset.streak.streak, 1, 'reset clears the previous matches')
})

test('shadow gate normalizes a legacy public result payload', async () => {
  const sqlitePath = tempSqlite()
  const legacy = legacyPublicResult()

  const result = await runShadowGate({ sqlitePath, legacyPayload: legacy, candidatePayload: legacy })
  assert.equal(result.equal, true, 'both sides normalize through the legacy branch')
  assert.equal(result.streak.streak, 1)

  const mismatch = await runShadowGate({
    sqlitePath,
    legacyPayload: legacy,
    candidatePayload: legacyPublicResult('Renamed subject'),
  })
  assert.equal(mismatch.equal, false)
  assert.equal(mismatch.streak.streak, 0)
})

test('parseShadowGateArgs requires the sqlite flag and rejects unknown options', () => {
  const sqlitePath = tempSqlite()
  writeFileSync(join(sqlitePath, '..', 'legacy.json'), '{}')
  assert.deepEqual(
    parseShadowGateArgs(['--sqlite', sqlitePath, '--legacy', 'legacy.json', '--candidate', 'candidate.json', '--reset']),
    { reset: true, sqlitePath, legacyPath: 'legacy.json', candidatePath: 'candidate.json' },
  )
  assert.throws(() => parseShadowGateArgs(['--legacy', 'legacy.json']), /--sqlite/)
  assert.throws(() => parseShadowGateArgs(['--sqlite', sqlitePath, '--nope']), /Unknown option/)
  assert.throws(() => parseShadowGateArgs(['--sqlite']), /requires a value/)
})
