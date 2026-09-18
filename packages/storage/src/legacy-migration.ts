import { canonicalJson, sha256Canonical } from './canonical-json.ts'
import type { SubjectMediaRow } from './d1-types.ts'
import {
  imageStatusKey,
  subjectDetailKey,
  subjectMetaKey,
  subjectRefreshKey,
} from './index.ts'
import type { MigrationSummaryV1 } from './legacy-migration-types.ts'

export interface LegacyMigrationD1 {
  getSubjectMediaRow(subjectId: number): Promise<SubjectMediaRow | undefined>
  putSubjectMediaRow(row: SubjectMediaRow): Promise<{ rowsWritten: number }>
}

export interface LegacyKvReader {
  get(key: string, type: 'json'): Promise<unknown>
}

export interface LegacySubjectRecords {
  subject_id: number
  detail?: unknown
  meta?: unknown
  imageStatus?: unknown
  refresh?: unknown
}

export async function readLegacySubjectRecords(
  kv: LegacyKvReader,
  subjectId: number,
): Promise<LegacySubjectRecords> {
  const [detail, meta, imageStatus, refresh] = await Promise.all([
    kv.get(subjectDetailKey(subjectId), 'json'),
    kv.get(subjectMetaKey(subjectId), 'json'),
    kv.get(imageStatusKey(subjectId), 'json'),
    kv.get(subjectRefreshKey(subjectId), 'json'),
  ])
  const records: LegacySubjectRecords = { subject_id: subjectId }
  if (detail !== null && detail !== undefined) records.detail = detail
  if (meta !== null && meta !== undefined) records.meta = meta
  if (imageStatus !== null && imageStatus !== undefined) records.imageStatus = imageStatus
  if (refresh !== null && refresh !== undefined) records.refresh = refresh
  return records
}

function legacyDetailSubject(records: LegacySubjectRecords): unknown {
  const detail = records.detail
  if (detail === undefined) return undefined
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return 'invalid'
  const candidate = (detail as { subject?: unknown }).subject
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return 'invalid'
  return candidate
}

function r2Ref(imageStatus: unknown, size: 'common' | 'large'): string | null {
  if (typeof imageStatus !== 'object' || imageStatus === null) return null
  const part = (imageStatus as Record<string, unknown>)[size]
  if (typeof part !== 'object' || part === null) return null
  const ref = part as { status?: unknown; r2_key?: unknown }
  return ref.status === 'cached' && typeof ref.r2_key === 'string' && ref.r2_key.length > 0
    ? ref.r2_key
    : null
}

function sourceUrl(detailSubject: unknown, size: 'common' | 'large'): string | null {
  if (typeof detailSubject !== 'object' || detailSubject === null) return null
  const images = (detailSubject as { images?: unknown }).images
  if (typeof images !== 'object' || images === null) return null
  const value = (images as Record<string, unknown>)[size]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export async function importLegacySubjectBatch(
  store: LegacyMigrationD1,
  kv: LegacyKvReader,
  subjectIds: number[],
): Promise<MigrationSummaryV1> {
  const summary: MigrationSummaryV1 = {
    imported: 0,
    skipped_existing: 0,
    missing_keys: 0,
    errored: 0,
    updated_at: Date.now(),
  }
  for (const subjectId of subjectIds) {
    let records: LegacySubjectRecords
    try {
      records = await readLegacySubjectRecords(kv, subjectId)
    } catch {
      // Malformed stored JSON makes KV.get(..., 'json') throw; count the
      // subject as errored without stalling the whole migration batch.
      summary.errored++
      continue
    }
    const detailSubject = legacyDetailSubject(records)
    if (detailSubject === 'invalid') {
      summary.errored++
      continue
    }
    const hasImportable = records.meta !== undefined
      || records.imageStatus !== undefined
      || detailSubject !== undefined
    if (!hasImportable) {
      summary.missing_keys++
      continue
    }
    const existing = await store.getSubjectMediaRow(subjectId)
    if (existing && (
      existing.checked_at !== null
      || existing.detail_json !== null
      || existing.r2_image_common_key !== null
      || existing.r2_image_large_key !== null
    )) {
      summary.skipped_existing++
      continue
    }
    const metaNsfw = records.meta !== undefined
      && typeof records.meta === 'object'
      && records.meta !== null
      && (records.meta as { nsfw?: unknown }).nsfw === true
    const detailNsfw = detailSubject !== undefined
      && typeof detailSubject === 'object'
      && detailSubject !== null
      && (detailSubject as { nsfw?: unknown }).nsfw === true
    const checkedAt = records.meta !== undefined
      && typeof records.meta === 'object'
      && records.meta !== null
      && typeof (records.meta as { checked_at?: unknown }).checked_at === 'number'
      ? (records.meta as { checked_at: number }).checked_at
      : null
    const row: SubjectMediaRow = {
      subject_id: subjectId,
      detail_json: detailSubject === undefined ? null : canonicalJson(detailSubject),
      detail_hash: detailSubject === undefined ? null : await sha256Canonical(detailSubject),
      media_hash: null,
      nsfw: metaNsfw || detailNsfw ? 1 : 0,
      source_image_common_url: sourceUrl(detailSubject, 'common'),
      source_image_large_url: sourceUrl(detailSubject, 'large'),
      r2_image_common_key: r2Ref(records.imageStatus, 'common'),
      r2_image_large_key: r2Ref(records.imageStatus, 'large'),
      checked_at: checkedAt,
      next_refresh_at: null,
      retry_count: 0,
      retry_after: null,
      error_code: null,
    }
    row.media_hash = await sha256Canonical({
      nsfw: row.nsfw,
      source_image_common_url: row.source_image_common_url,
      source_image_large_url: row.source_image_large_url,
      r2_image_common_key: row.r2_image_common_key,
      r2_image_large_key: row.r2_image_large_key,
    })
    await store.putSubjectMediaRow(row)
    summary.imported++
  }
  return summary
}
