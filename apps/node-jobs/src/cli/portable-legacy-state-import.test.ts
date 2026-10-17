import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildPublicSnapshot } from '@airing-cal/domain'
import {
  imageStatusKey,
  migrateLegacyCursorKey,
  migrateLegacySummaryKey,
  subjectDetailKey,
  subjectMetaKey,
  type PublicCollectionItemV1,
  type MigrationCursorV1,
  type MigrationSummaryV1,
} from '@airing-cal/storage'
import {
  openBuilderDatabase,
  SqliteBuilderStateStore,
  SqliteSubjectMediaStore,
} from '@airing-cal/v3-builder'
import {
  MAX_LEGACY_IMPORT_BATCH,
  parseLegacyStateImportArgs,
  resolveCliSubjectIds,
  runLegacyStateImport,
  subjectIdsFromSnapshot,
} from './portable-legacy-state-import.ts'

const IMAGE_HASH = 'a'.repeat(64)

function collectionItem(subject_id: number, collection_type: number): PublicCollectionItemV1 {
  return {
    subject_id,
    name: `Subject ${subject_id}`,
    name_cn: '',
    summary: '',
    images: { common: null, large: null },
    image_status: { common: 'cached', large: 'pending_next_cron' },
    eps: 12,
    total_episodes: 12,
    ep_status: 0,
    vol_status: 0,
    type: 2,
    collection_type,
    rate: 0,
    nsfw: false,
    date: '2026-10-17',
    tags: [],
    updated_at: '2026-10-17T00:00:00Z',
  }
}

/** Snapshot whose collections/calendar cover subject ids 10, 20, 30 (collections) and 40 (calendar). */
async function snapshotFixture() {
  return buildPublicSnapshot({
    collections: [collectionItem(10, 3), collectionItem(20, 2), collectionItem(30, 5)],
    calendar: [{
      weekday: { en: 'Sat', cn: '六', ja: '土', id: 6 },
      items: [{
        subject_id: 40,
        id: 40,
        type: 2,
        name: 'Calendar subject',
        name_cn: '',
        summary: '',
        images: { common: null, large: null },
        image_status: { common: 'pending_next_cron', large: 'pending_next_cron' },
        nsfw: false,
        date: '2026-10-17',
        eps: 12,
        total_episodes: 12,
      }],
    }],
    published_at: 1_722_000_000,
  }, 1)
}

/** KV export: subject 10 detail+meta, subject 20 image status, subject 30 malformed, subject 40 absent. */
function kvExportFixture(): Record<string, unknown> {
  return {
    [subjectDetailKey(10)]: {
      cached_at: 1_700_000_000,
      subject: {
        id: 10,
        name: 'Imported',
        nsfw: false,
        images: { common: 'https://lain.bgm.tv/10.jpg', large: null },
      },
    },
    [subjectMetaKey(10)]: { checked_at: 1_700_000_100, nsfw: false },
    [imageStatusKey(20)]: {
      common: { status: 'cached', hash: IMAGE_HASH, uri: `/image/${IMAGE_HASH}`, r2_key: `images/${IMAGE_HASH}/original` },
      large: { status: 'failed', hash: null, uri: null, r2_key: null },
    },
    [subjectDetailKey(30)]: 'not-an-object',
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'airingcal-legacy-import-'))
}

test('subjectIdsFromSnapshot unions collections and calendar in ascending order', async () => {
  assert.deepEqual(subjectIdsFromSnapshot(await snapshotFixture()), [10, 20, 30, 40])
})

test('runLegacyStateImport imports legacy KV records into SQLite and persists cursor and summary', async () => {
  const sqlitePath = join(tempDir(), 'builder.sqlite')
  const batches: number[] = []
  const result = await runLegacyStateImport({
    sqlitePath,
    kvExport: kvExportFixture(),
    subjectIds: [10, 20, 30, 40],
    batchSize: 3,
    now: () => 1_700_000_000_000,
    onBatch: (batch) => batches.push(batch),
  })

  assert.deepEqual(batches, [1, 2])
  assert.deepEqual(
    {
      imported: result.summary.imported,
      skipped_existing: result.summary.skipped_existing,
      missing_keys: result.summary.missing_keys,
      errored: result.summary.errored,
    },
    { imported: 2, skipped_existing: 0, missing_keys: 1, errored: 1 },
  )
  assert.equal(result.summary.updated_at, result.batches.at(-1)?.updated_at, 'summary carries the last batch timestamp')
  assert.deepEqual(result.cursor, { last_subject_id: 40, batch_index: 2, updated_at: 1_700_000_000 })


  const db = openBuilderDatabase(sqlitePath)
  try {
    const store = new SqliteSubjectMediaStore(db)
    const state = new SqliteBuilderStateStore(db)
    const imported = await store.getSubjectMediaRow(10)
    assert.equal(imported?.nsfw, 0)
    assert.equal(imported?.source_image_common_url, 'https://lain.bgm.tv/10.jpg')
    assert.equal(imported?.checked_at, 1_700_000_100)
    assert.deepEqual(JSON.parse(imported?.detail_json ?? 'null'), {
      id: 10,
      name: 'Imported',
      nsfw: false,
      images: { common: 'https://lain.bgm.tv/10.jpg', large: null },
    })
    const mediaOnly = await store.getSubjectMediaRow(20)
    assert.equal(mediaOnly?.r2_image_common_key, `images/${IMAGE_HASH}/original`)
    assert.equal(mediaOnly?.detail_json, null)
    assert.equal(await store.getSubjectMediaRow(30), undefined, 'malformed records must not create rows')
    assert.equal(await store.getSubjectMediaRow(40), undefined, 'subjects without KV records are untouched')

    assert.equal(
      JSON.parse(await state.getKv(migrateLegacyCursorKey()) ?? 'null').batch_index,
      2,
    )
    assert.equal(
      JSON.parse(await state.getKv(migrateLegacySummaryKey()) ?? 'null').imported,
      2,
    )
  } finally {
    db.close()
  }
})

test('runLegacyStateImport is idempotent across re-runs', async () => {
  const sqlitePath = join(tempDir(), 'builder.sqlite')
  const first = await runLegacyStateImport({
    sqlitePath,
    kvExport: kvExportFixture(),
    subjectIds: [10, 20, 30, 40],
  })
  assert.equal(first.summary.imported, 2)

  const rerun = await runLegacyStateImport({
    sqlitePath,
    kvExport: kvExportFixture(),
    subjectIds: [10, 20, 30, 40],
  })
  assert.deepEqual(rerun.summary, {
    imported: 0,
    skipped_existing: 2,
    missing_keys: 1,
    errored: 1,
    updated_at: rerun.summary.updated_at,
  }, 're-running must not duplicate rows')

  const db = openBuilderDatabase(sqlitePath)
  try {
    assert.equal(await new SqliteSubjectMediaStore(db).getSubjectMediaRow(30), undefined)
  } finally {
    db.close()
  }
})

test('runLegacyStateImport resumes after an interrupted batch', async () => {
  const sqlitePath = join(tempDir(), 'builder.sqlite')
  const partial = await runLegacyStateImport({
    sqlitePath,
    kvExport: kvExportFixture(),
    subjectIds: [10, 20, 30],
  })
  assert.deepEqual(
    { imported: partial.summary.imported, errored: partial.summary.errored },
    { imported: 2, errored: 1 },
  )
  assert.equal(partial.cursor?.last_subject_id, 30)
  assert.equal(partial.cursor?.batch_index, 1)

  const resumed = await runLegacyStateImport({
    sqlitePath,
    kvExport: kvExportFixture(),
    subjectIds: [10, 20, 30, 40],
    resume: true,
  })
  assert.deepEqual(resumed.batches, [{
    imported: 0,
    skipped_existing: 0,
    missing_keys: 1,
    errored: 0,
    updated_at: resumed.summary.updated_at,
  }], 'resume continues after the persisted cursor (subject 40 only)')
  assert.equal(resumed.cursor?.last_subject_id, 40)
  assert.equal(resumed.cursor?.batch_index, 2, 'resume keeps counting batches from the stored cursor')
})

test('runLegacyStateImport rejects invalid batch sizes', async () => {
  await assert.rejects(
    () => runLegacyStateImport({
      sqlitePath: join(tempDir(), 'builder.sqlite'),
      kvExport: {},
      subjectIds: [10],
      batchSize: MAX_LEGACY_IMPORT_BATCH + 1,
    }),
    /batch size/,
  )
})

test('parseLegacyStateImportArgs reads the documented flags', () => {
  assert.deepEqual(parseLegacyStateImportArgs(['export.json', '--sqlite', 'builder.sqlite', '--subject-ids', '10, 20', '--batch-size', '5', '--resume']), {
    kvExportPath: 'export.json',
    sqlitePath: 'builder.sqlite',
    subjectIds: [10, 20],
    batchSize: 5,
    resume: true,
  })
  assert.throws(() => parseLegacyStateImportArgs(['export.json', '--nope']), /Unknown option/)
  assert.throws(() => parseLegacyStateImportArgs(['export.json', '--subject-ids', 'abc']), /Invalid subject id/)
  assert.throws(() => parseLegacyStateImportArgs(['export.json', '--batch-size', '51']), /--batch-size/)
  assert.throws(() => parseLegacyStateImportArgs(['export.json', '--sqlite']), /requires a value/)
})

test('resolveCliSubjectIds prefers explicit ids and falls back to the snapshot', async () => {
  const dir = tempDir()
  const snapshotPath = join(dir, 'public-snapshot.json')
  writeFileSync(snapshotPath, JSON.stringify(await snapshotFixture()))

  assert.deepEqual(await resolveCliSubjectIds({ subjectIds: [5], resume: false }), [5])
  assert.deepEqual(
    await resolveCliSubjectIds({ snapshotPath, resume: false }, (path) => readFileSync(path, 'utf8')),
    [10, 20, 30, 40],
  )
  await assert.rejects(() => resolveCliSubjectIds({ resume: false }), /Provide --snapshot/)
})

test('runLegacyStateImport keeps working against a snapshot-backed subject set', async () => {
  const dir = tempDir()
  const snapshotPath = join(dir, 'public-snapshot.json')
  writeFileSync(snapshotPath, JSON.stringify(await snapshotFixture()))
  const result = await runLegacyStateImport({
    sqlitePath: join(dir, 'builder.sqlite'),
    kvExport: kvExportFixture(),
    subjectIds: await resolveCliSubjectIds({ snapshotPath, resume: false }),
  })
  assert.equal(result.summary.imported + result.summary.skipped_existing, 2)

  const db = openBuilderDatabase(join(dir, 'builder.sqlite'))
  try {
    const summary = JSON.parse(await new SqliteBuilderStateStore(db).getKv(migrateLegacySummaryKey()) ?? 'null') as MigrationSummaryV1
    const cursor = JSON.parse(await new SqliteBuilderStateStore(db).getKv(migrateLegacyCursorKey()) ?? 'null') as MigrationCursorV1
    assert.equal(summary.imported, 2)
    assert.equal(cursor.batch_index, 1)
  } finally {
    db.close()
  }
})
