import type { DatabaseSync } from 'node:sqlite'
import type { LegacyMigrationD1, SubjectMediaRow } from '@airing-cal/storage'

const SELECT_SUBJECT_MEDIA_ROW = `SELECT subject_id, detail_json, detail_hash, media_hash, nsfw,
  source_image_common_url, source_image_large_url,
  r2_image_common_key, r2_image_large_key,
  checked_at, next_refresh_at, retry_count, retry_after, error_code
  FROM subject_media WHERE subject_id = ?`

/**
 * Upsert keeps an existing row's detail when the imported row has none
 * (`COALESCE(excluded.detail_json, subject_media.detail_json)`), matching the
 * v2 media writer in `apps/node-jobs/src/sync/media-refresh.ts`.
 */
const UPSERT_SUBJECT_MEDIA_ROW = `INSERT INTO subject_media (
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

function mapRow(row: Record<string, unknown>): SubjectMediaRow {
  return {
    subject_id: row.subject_id as number,
    detail_json: (row.detail_json as string | null) ?? null,
    detail_hash: (row.detail_hash as string | null) ?? null,
    media_hash: (row.media_hash as string | null) ?? null,
    nsfw: (row.nsfw as 0 | 1) ?? 0,
    source_image_common_url: (row.source_image_common_url as string | null) ?? null,
    source_image_large_url: (row.source_image_large_url as string | null) ?? null,
    r2_image_common_key: (row.r2_image_common_key as string | null) ?? null,
    r2_image_large_key: (row.r2_image_large_key as string | null) ?? null,
    checked_at: (row.checked_at as number | null) ?? null,
    next_refresh_at: (row.next_refresh_at as number | null) ?? null,
    retry_count: (row.retry_count as number) ?? 0,
    retry_after: (row.retry_after as number | null) ?? null,
    error_code: (row.error_code as string | null) ?? null,
  }
}

/**
 * Builder-SQLite implementation of the legacy migration store port, so the v2
 * state import can run against the portable checkpoint (#73) without D1.
 */
export class SqliteSubjectMediaStore implements LegacyMigrationD1 {
  constructor(readonly db: DatabaseSync) {}

  async getSubjectMediaRow(subjectId: number): Promise<SubjectMediaRow | undefined> {
    const row = this.db.prepare(SELECT_SUBJECT_MEDIA_ROW).get(subjectId) as Record<string, unknown> | undefined
    return row ? mapRow(row) : undefined
  }

  async putSubjectMediaRow(row: SubjectMediaRow): Promise<{ rowsWritten: number }> {
    const result = this.db.prepare(UPSERT_SUBJECT_MEDIA_ROW).run(
      row.subject_id,
      row.detail_json,
      row.detail_hash,
      row.media_hash,
      row.nsfw,
      row.source_image_common_url,
      row.source_image_large_url,
      row.r2_image_common_key,
      row.r2_image_large_key,
      row.checked_at,
      row.next_refresh_at,
      row.retry_count,
      row.retry_after,
      row.error_code,
    )
    return { rowsWritten: Number(result.changes) }
  }
}
