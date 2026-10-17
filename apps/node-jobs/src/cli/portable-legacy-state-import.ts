import { readFileSync } from 'node:fs'
import { parsePublicSnapshotV1 } from '@airing-cal/domain'
import {
  importLegacySubjectBatch,
  migrateLegacyCursorKey,
  migrateLegacySummaryKey,
  type LegacyKvReader,
  type MigrationCursorV1,
  type MigrationSummaryV1,
  type PublicSnapshotV1,
} from '@airing-cal/storage'
import {
  openBuilderDatabase,
  SqliteBuilderStateStore,
  SqliteSubjectMediaStore,
} from '@airing-cal/v3-builder'

export const MAX_LEGACY_IMPORT_BATCH = 50
const DEFAULT_BATCH_SIZE = MAX_LEGACY_IMPORT_BATCH

/** `LegacyKvReader` over a JSON export of v2 KV entries (`{ "<key>": <value> }`). */
class JsonKvReader implements LegacyKvReader {
  constructor(readonly entries: Record<string, unknown>) {}

  async get(key: string, _type: 'json'): Promise<unknown> {
    return Object.hasOwn(this.entries, key) ? this.entries[key] : null
  }
}

/** Collection + calendar subject ids of a published snapshot, ascending and unique. */
export function subjectIdsFromSnapshot(snapshot: PublicSnapshotV1): number[] {
  const ids = new Set<number>()
  for (const items of Object.values(snapshot.collections)) {
    for (const item of items) ids.add(item.subject_id)
  }
  for (const day of snapshot.calendar) {
    for (const item of day.items) ids.add(item.subject_id)
  }
  return [...ids].sort((a, b) => a - b)
}

export interface LegacyStateImportOptions {
  sqlitePath: string
  kvExport: Record<string, unknown>
  subjectIds: number[]
  batchSize?: number
  /** Skip subjects at or below the persisted cursor, continuing an interrupted import. */
  resume?: boolean
  /** Clock for the persisted cursor (unix seconds); defaults to `Date.now`. */
  now?: () => number
  onBatch?: (batch: number, summary: MigrationSummaryV1) => void
}

export interface LegacyStateImportResult {
  batches: MigrationSummaryV1[]
  summary: MigrationSummaryV1
  cursor: MigrationCursorV1 | null
}

/** Batch size shared by the CLI flags and the programmatic entry point. */
export function validateBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEGACY_IMPORT_BATCH) {
    throw new Error(`batch size must be an integer between 1 and ${MAX_LEGACY_IMPORT_BATCH}`)
  }
  return value
}

/** Returns null for a corrupt cursor so the import restarts instead of skipping subjects. */
function parseMigrationCursor(raw: string): MigrationCursorV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<MigrationCursorV1>
    if (
      !Number.isSafeInteger(value.last_subject_id)
      || (value.last_subject_id ?? -1) < 0
      || !Number.isSafeInteger(value.batch_index)
      || (value.batch_index ?? -1) < 0
      || !Number.isSafeInteger(value.updated_at)
    ) {
      return null
    }
    return value as MigrationCursorV1
  } catch {
    return null
  }
}

/** Returns null for a corrupt summary; resumed runs then restart their counters. */
function parseMigrationSummary(raw: string): MigrationSummaryV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<MigrationSummaryV1>
    for (const count of [value.imported, value.skipped_existing, value.missing_keys, value.errored]) {
      if (!Number.isSafeInteger(count) || (count ?? -1) < 0) return null
    }
    if (!Number.isSafeInteger(value.updated_at)) return null
    return value as MigrationSummaryV1
  } catch {
    return null
  }
}

/**
 * Read-only v2 legacy state import into the builder SQLite checkpoint (#73).
 * Writes `subject_media` rows plus the migration cursor/summary in `builder_kv`;
 * never touches the public store, so re-runs are idempotent and rollback is
 * "restore the pre-import checkpoint backup".
 *
 * `summary.updated_at` is the batch timestamp (milliseconds, as produced by
 * `importLegacySubjectBatch`); `cursor.updated_at` is unix seconds.
 *
 * Resume semantics: a resumed run continues the persisted summary counters and
 * re-processes only subjects above the persisted cursor. `errored` subjects are
 * **not** retried by `--resume` (the cursor has moved past them); re-run without
 * `--resume` to retry them — already-imported rows are counted as
 * `skipped_existing` and left untouched.
 */
export async function runLegacyStateImport(
  options: LegacyStateImportOptions,
): Promise<LegacyStateImportResult> {
  const batchSize = validateBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE)
  const now = options.now ?? Date.now
  const db = openBuilderDatabase(options.sqlitePath)
  try {
    const state = new SqliteBuilderStateStore(db)
    const store = new SqliteSubjectMediaStore(db)
    const reader = new JsonKvReader(options.kvExport)

    let cursor: MigrationCursorV1 | null = null
    let summary: MigrationSummaryV1 = {
      imported: 0,
      skipped_existing: 0,
      missing_keys: 0,
      errored: 0,
      updated_at: now(),
    }
    if (options.resume) {
      // A corrupt/hand-edited cursor or summary is ignored rather than trusted:
      // the import re-walks the full set (idempotent, `skipped_existing` protects
      // existing rows) instead of silently skipping subjects.
      const rawCursor = await state.getKv(migrateLegacyCursorKey())
      cursor = rawCursor ? parseMigrationCursor(rawCursor) : null
      const rawSummary = await state.getKv(migrateLegacySummaryKey())
      const persisted = rawSummary ? parseMigrationSummary(rawSummary) : null
      if (persisted) summary = persisted
    }

    const after = cursor?.last_subject_id ?? 0
    const pending = [...new Set(options.subjectIds)]
      .filter((id) => Number.isSafeInteger(id) && id > 0 && (!options.resume || id > after))
      .sort((a, b) => a - b)
    const batches: MigrationSummaryV1[] = []
    let batchIndex = cursor?.batch_index ?? 0
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const chunk = pending.slice(offset, offset + batchSize)
      const batchSummary = await importLegacySubjectBatch(store, reader, chunk)
      batches.push(batchSummary)
      summary = {
        imported: summary.imported + batchSummary.imported,
        skipped_existing: summary.skipped_existing + batchSummary.skipped_existing,
        missing_keys: summary.missing_keys + batchSummary.missing_keys,
        errored: summary.errored + batchSummary.errored,
        updated_at: batchSummary.updated_at,
      }
      batchIndex += 1
      cursor = {
        last_subject_id: Math.max(chunk[chunk.length - 1] ?? 0, after),
        batch_index: batchIndex,
        updated_at: Math.floor(now() / 1000),
      }
      await state.setKv(migrateLegacyCursorKey(), JSON.stringify(cursor))
      await state.setKv(migrateLegacySummaryKey(), JSON.stringify(summary))
      options.onBatch?.(batchIndex, batchSummary)
    }
    return { batches, summary, cursor }
  } finally {
    db.close()
  }
}

export interface LegacyStateImportCliArgs {
  kvExportPath?: string
  sqlitePath?: string
  snapshotPath?: string
  subjectIds?: number[]
  batchSize?: number
  resume: boolean
}

function parseSubjectIds(value: string): number[] {
  const ids = value.split(',').map((part) => Number(part.trim()))
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid subject id: ${value}`)
  }
  return ids
}

export function parseLegacyStateImportArgs(argv: string[]): LegacyStateImportCliArgs {
  const args: LegacyStateImportCliArgs = { resume: false }
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--resume') {
      args.resume = true
      continue
    }
    if (['--sqlite', '--snapshot', '--subject-ids', '--batch-size'].includes(arg)) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      if (arg === '--sqlite') args.sqlitePath = value
      if (arg === '--snapshot') args.snapshotPath = value
      if (arg === '--subject-ids') args.subjectIds = parseSubjectIds(value)
      if (arg === '--batch-size') args.batchSize = validateBatchSize(Number(value))
      continue
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`)
    positional.push(arg)
  }
  args.kvExportPath = positional[0]
  if (positional.length > 1) throw new Error('Only one KV export path is accepted')
  return args
}

/** Resolves the subject set from `--subject-ids` or the published snapshot's collections/calendar. */
export async function resolveCliSubjectIds(
  args: LegacyStateImportCliArgs,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Promise<number[]> {
  if (args.subjectIds?.length) return args.subjectIds
  if (!args.snapshotPath) {
    throw new Error('Provide --snapshot <PublicSnapshotV1 json> or --subject-ids <id,id,...>')
  }
  return subjectIdsFromSnapshot(await parsePublicSnapshotV1(JSON.parse(readFile(args.snapshotPath))))
}

if (process.argv[1]?.endsWith('portable-legacy-state-import.ts')) {
  void (async () => {
    try {
      const args = parseLegacyStateImportArgs(process.argv.slice(2))
      if (!args.kvExportPath) {
        throw new Error(
          'Usage: portable-legacy-state-import.ts <kv-export.json> --sqlite <path> '
          + '[--snapshot <path>|--subject-ids <ids>] [--batch-size N] [--resume]',
        )
      }
      if (!args.sqlitePath) throw new Error('--sqlite <path> is required')
      const kvExport = JSON.parse(readFileSync(args.kvExportPath, 'utf8')) as Record<string, unknown>
      const result = await runLegacyStateImport({
        sqlitePath: args.sqlitePath,
        kvExport,
        subjectIds: await resolveCliSubjectIds(args),
        batchSize: args.batchSize,
        resume: args.resume,
        onBatch: (batch, summary) => {
          console.log(JSON.stringify({ status: 'info', stage: 'legacy_state_import_batch', batch, summary }))
        },
      })
      console.log(JSON.stringify({
        status: 'ok',
        stage: 'legacy_state_import',
        sqlite: args.sqlitePath,
        subjects: result.summary.imported + result.summary.skipped_existing
          + result.summary.missing_keys + result.summary.errored,
        batches: result.batches.length,
        summary: result.summary,
        cursor: result.cursor,
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'import_failed'
      console.error(JSON.stringify({ status: 'failed', stage: 'legacy_state_import', message }))
      process.exit(1)
    }
  })()
}
