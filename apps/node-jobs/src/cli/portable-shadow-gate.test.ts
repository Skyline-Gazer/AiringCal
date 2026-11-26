import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildPublicSnapshot } from '@airing-cal/domain'
import {
  migrateShadowStreakKey,
  type PublicCollectionItemV1,
} from '@airing-cal/storage'
import { openBuilderDatabase, SqliteBuilderStateStore } from '@airing-cal/v3-builder'
import {
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

async function leftoverStreak(sqlitePath: string): Promise<string | null> {
  const db = openBuilderDatabase(sqlitePath)
  try {
    return await new SqliteBuilderStateStore(db).getKv(migrateShadowStreakKey())
  } finally {
    db.close()
  }
}

test('shadow gate exits open on a single equal compare and closed on mismatch', async () => {
  const sqlitePath = tempSqlite()
  const candidate = await snapshotFixture()
  const renamed = await snapshotFixture('Renamed subject')

  const equal = await runShadowGate({
    sqlitePath,
    legacyPayload: candidate,
    candidatePayload: candidate,
    now: () => 1_700_000_000_000,
  })
  assert.equal(equal.equal, true)
  assert.equal(equal.diff_count, 0)
  assert.equal('cutover_allowed' in equal, false)
  assert.equal('required_matches' in equal, false)
  assert.equal('streak' in equal, false)
  assert.equal(await leftoverStreak(sqlitePath), null, 'equal compare must not mutate streak key')

  const mismatch = await runShadowGate({
    sqlitePath,
    legacyPayload: renamed,
    candidatePayload: candidate,
    now: () => 1_700_000_001_000,
  })
  assert.equal(mismatch.equal, false)
  assert.ok(mismatch.diff_count > 0)
  assert.equal(await leftoverStreak(sqlitePath), null, 'mismatch compare must not mutate streak key')
})

test('shadow gate normalizes a legacy public result payload', async () => {
  const sqlitePath = tempSqlite()
  const legacy = legacyPublicResult()

  const result = await runShadowGate({ sqlitePath, legacyPayload: legacy, candidatePayload: legacy })
  assert.equal(result.equal, true, 'both sides normalize through the legacy branch')
  assert.equal(result.diff_count, 0)

  const mismatch = await runShadowGate({
    sqlitePath,
    legacyPayload: legacy,
    candidatePayload: legacyPublicResult('Renamed subject'),
  })
  assert.equal(mismatch.equal, false)
  assert.ok(mismatch.diff_count > 0)
})

test('reset clears a leftover streak key without rewriting streak state', async () => {
  const sqlitePath = tempSqlite()
  const db = openBuilderDatabase(sqlitePath)
  try {
    await new SqliteBuilderStateStore(db).setKv(migrateShadowStreakKey(), '{"streak":3}')
  } finally {
    db.close()
  }

  assert.ok(await leftoverStreak(sqlitePath))
  await resetShadowStreak(sqlitePath)
  assert.equal(await leftoverStreak(sqlitePath), null)
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
