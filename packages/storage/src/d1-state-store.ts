import type { SubjectMediaRow } from './d1-types.ts'

/** Column order shared by the builder-SQLite subject_media table. */
export const SUBJECT_MEDIA_COLUMNS = [
  'subject_id',
  'detail_json',
  'detail_hash',
  'media_hash',
  'nsfw',
  'source_image_common_url',
  'source_image_large_url',
  'r2_image_common_key',
  'r2_image_large_key',
  'checked_at',
  'next_refresh_at',
  'retry_count',
  'retry_after',
  'error_code',
] as const

export class StaleCollectionDiffError extends Error {
  readonly code = 'STALE_COLLECTION_DIFF'

  constructor(
    readonly userId: string,
    readonly subjectId: number,
  ) {
    super(`Stale collection diff conflict: ${userId}:${subjectId}`)
    this.name = 'StaleCollectionDiffError'
  }
}

export class SyncRunCheckpointConflictError extends Error {
  readonly code = 'SYNC_RUN_CHECKPOINT_CONFLICT'

  constructor(instanceId: string, options?: { cause?: unknown }) {
    super(`Sync run checkpoint conflict: ${instanceId}`, options)
    this.name = 'SyncRunCheckpointConflictError'
  }
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid collection_items.${column}`)
  return value
}

function nullableString(value: unknown, column: string): string | null {
  if (value === null) return null
  return requireString(value, column)
}

function requireInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid collection_items.${column}`)
  }
  return value
}

function requirePositiveInteger(value: unknown, column: string): number {
  const integer = requireInteger(value, column)
  if (integer < 1) throw new Error(`Invalid collection_items.${column}`)
  return integer
}

function nullableInteger(value: unknown, column: string): number | null {
  if (value === null) return null
  return requireInteger(value, column)
}

function validateJson(value: string, column: string, requireArray = false): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`Invalid collection_items.${column}`)
  }
  if (requireArray && !Array.isArray(parsed)) throw new Error(`Invalid collection_items.${column}`)
  if (!requireArray && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    throw new Error(`Invalid collection_items.${column}`)
  }
  return value
}

/** Strict decoder for a `subject_media` row in the builder SQLite store. */
export function decodeSubjectMediaRow(raw: Record<string, unknown>): SubjectMediaRow {
  const nsfw = requireInteger(raw.nsfw, 'nsfw')
  if (nsfw !== 0 && nsfw !== 1) throw new Error('Invalid subject_media.nsfw')
  const detailJson = nullableString(raw.detail_json, 'detail_json')
  if (detailJson !== null) validateJson(detailJson, 'detail_json')
  const retryCount = requireInteger(raw.retry_count, 'retry_count')
  if (retryCount < 0) throw new Error('Invalid subject_media.retry_count')
  return {
    subject_id: requirePositiveInteger(raw.subject_id, 'subject_id'),
    detail_json: detailJson,
    detail_hash: nullableString(raw.detail_hash, 'detail_hash'),
    media_hash: nullableString(raw.media_hash, 'media_hash'),
    nsfw,
    source_image_common_url: nullableString(raw.source_image_common_url, 'source_image_common_url'),
    source_image_large_url: nullableString(raw.source_image_large_url, 'source_image_large_url'),
    r2_image_common_key: nullableString(raw.r2_image_common_key, 'r2_image_common_key'),
    r2_image_large_key: nullableString(raw.r2_image_large_key, 'r2_image_large_key'),
    checked_at: nullableInteger(raw.checked_at, 'checked_at'),
    next_refresh_at: nullableInteger(raw.next_refresh_at, 'next_refresh_at'),
    retry_count: retryCount,
    retry_after: nullableInteger(raw.retry_after, 'retry_after'),
    error_code: nullableString(raw.error_code, 'error_code'),
  }
}

/** SQL parameter list for {@link SUBJECT_MEDIA_COLUMNS}, in column order. */
export function subjectMediaValues(row: SubjectMediaRow): unknown[] {
  return SUBJECT_MEDIA_COLUMNS.map((column) => row[column])
}
