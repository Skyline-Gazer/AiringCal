import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  SUBJECT_MEDIA_COLUMNS,
  decodeSubjectMediaRow,
  subjectMediaValues,
  type LegacyMigrationD1,
  type SubjectMediaRow,
} from '@airing-cal/storage'

const SELECT_SUBJECT_MEDIA_ROW = `SELECT ${SUBJECT_MEDIA_COLUMNS.join(', ')}
  FROM subject_media WHERE subject_id = ?`

/**
 * Subject media upsert shared with the portable media writer
 * (`apps/node-jobs/src/sync/media-refresh.ts`): an incoming row without detail
 * keeps the stored `detail_json`/`detail_hash` (`COALESCE`), so an import cannot
 * erase a newer detail.
 */
export const SUBJECT_MEDIA_COALESCE_UPSERT = `INSERT INTO subject_media (
  subject_id, detail_json, detail_hash, media_hash, nsfw,
  source_image_common_url, source_image_large_url,
  r2_image_common_key, r2_image_large_key,
  checked_at, next_refresh_at, retry_count, retry_after, error_code
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(subject_id) DO UPDATE SET
  detail_json = COALESCE(excluded.detail_json, subject_media.detail_json),
  detail_hash = COALESCE(excluded.detail_hash, subject_media.detail_hash),
  media_hash = excluded.media_hash,
  nsfw = excluded.nsfw,
  source_image_common_url = excluded.source_image_common_url,
  source_image_large_url = excluded.source_image_large_url,
  r2_image_common_key = excluded.r2_image_common_key,
  r2_image_large_key = excluded.r2_image_large_key,
  checked_at = excluded.checked_at,
  next_refresh_at = excluded.next_refresh_at,
  retry_count = excluded.retry_count,
  retry_after = excluded.retry_after,
  error_code = excluded.error_code`

/**
 * Builder-SQLite implementation of the legacy migration store port, so the v2
 * state import can run against the portable checkpoint (#73) without D1.
 * Rows are decoded with the same strict decoder as the D1 store.
 */
export class SqliteSubjectMediaStore implements LegacyMigrationD1 {
  constructor(readonly db: DatabaseSync) {}

  async getSubjectMediaRow(subjectId: number): Promise<SubjectMediaRow | undefined> {
    const row = this.db.prepare(SELECT_SUBJECT_MEDIA_ROW).get(subjectId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : decodeSubjectMediaRow(row)
  }

  async putSubjectMediaRow(row: SubjectMediaRow): Promise<{ rowsWritten: number }> {
    const result = this.db
      .prepare(SUBJECT_MEDIA_COALESCE_UPSERT)
      .run(...(subjectMediaValues(row) as SQLInputValue[]))
    return { rowsWritten: Number(result.changes) }
  }
}
