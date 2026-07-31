import {
  importLegacySubjectBatch,
  migrateLegacyCursorKey,
  migrateLegacySummaryKey,
  type CollectionRow,
  type LegacyKvReader,
  type MigrationCursorV1,
  type MigrationSummaryV1,
  type SubjectMediaRow,
} from '@airing-cal/storage'

const MIGRATION_BATCH_SIZE = 50

export interface MigrationRunnerD1 {
  listCollectionRows(): Promise<CollectionRow[]>
  getSubjectMediaRow(subjectId: number): Promise<SubjectMediaRow | undefined>
  putSubjectMediaRow(row: SubjectMediaRow): Promise<{ rowsWritten: number }>
  getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined>
  putAppStateIfNewer<T>(key: string, value: T, version: number): Promise<boolean>
}

function decodeMigrationCursor(value: unknown): MigrationCursorV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid migration cursor')
  }
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.last_subject_id)
    || (candidate.last_subject_id as number) < 0
    || !Number.isSafeInteger(candidate.batch_index)
    || (candidate.batch_index as number) < 0
    || typeof candidate.updated_at !== 'number') {
    throw new Error('Invalid migration cursor')
  }
  return {
    last_subject_id: candidate.last_subject_id as number,
    batch_index: candidate.batch_index as number,
    updated_at: candidate.updated_at as number,
  }
}

function decodeMigrationSummary(value: unknown): MigrationSummaryV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid migration summary')
  }
  const candidate = value as Record<string, unknown>
  for (const key of ['imported', 'skipped_existing', 'missing_keys', 'errored'] as const) {
    if (!Number.isSafeInteger(candidate[key]) || (candidate[key] as number) < 0) {
      throw new Error('Invalid migration summary')
    }
  }
  if (typeof candidate.updated_at !== 'number') throw new Error('Invalid migration summary')
  return {
    imported: candidate.imported as number,
    skipped_existing: candidate.skipped_existing as number,
    missing_keys: candidate.missing_keys as number,
    errored: candidate.errored as number,
    updated_at: candidate.updated_at as number,
  }
}

function emptySummary(updatedAt: number): MigrationSummaryV1 {
  return {
    imported: 0,
    skipped_existing: 0,
    missing_keys: 0,
    errored: 0,
    updated_at: updatedAt,
  }
}

export async function runLegacyMigration(
  store: MigrationRunnerD1,
  kv: LegacyKvReader,
  now: number,
): Promise<MigrationSummaryV1> {
  const cursor = await store.getAppState(migrateLegacyCursorKey(), decodeMigrationCursor)
  const rows = await store.listCollectionRows()
  const subjectIds = [...new Set(rows.map((row) => row.subject_id))].sort((a, b) => a - b)
  const startIndex = cursor === undefined
    ? 0
    : subjectIds.findIndex((subjectId) => subjectId > cursor.last_subject_id)
  const pending = startIndex === -1 ? [] : subjectIds.slice(startIndex)
  const summary = emptySummary(now)

  for (let offset = 0; offset < pending.length; offset += MIGRATION_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + MIGRATION_BATCH_SIZE)
    let batchSummary: MigrationSummaryV1
    try {
      batchSummary = await importLegacySubjectBatch(store, kv, batch)
    } catch {
      summary.errored += batch.length
      continue
    }
    summary.imported += batchSummary.imported
    summary.skipped_existing += batchSummary.skipped_existing
    summary.missing_keys += batchSummary.missing_keys
    summary.errored += batchSummary.errored
    await store.putAppStateIfNewer(migrateLegacyCursorKey(), {
      last_subject_id: batch[batch.length - 1],
      batch_index: Math.floor(offset / MIGRATION_BATCH_SIZE),
      updated_at: now,
    } satisfies MigrationCursorV1, now)
  }

  await store.putAppStateIfNewer(migrateLegacySummaryKey(), summary, now)
  return summary
}
