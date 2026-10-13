export const thumbBackfillBoundary = 'web-worker-thumb-backfill'

import { D1StateStore, type D1DatabaseLike } from '@airing-cal/storage'
import {
  hashFromLargeR2Key,
  materializeThumb,
  summarizeThumbResults,
  type ThumbGenItemResult,
  type ThumbMaterializeEnv,
} from './thumb-materialize.ts'

export const THUMB_BACKFILL_CURSOR_KEY = 'thumb_backfill:cursor'
export const DEFAULT_THUMB_BACKFILL_BATCH = 30

const SUBJECT_MEDIA_LARGE_SELECT = `SELECT subject_id, r2_image_large_key
FROM subject_media
WHERE r2_image_large_key IS NOT NULL
  AND subject_id > ?
ORDER BY subject_id ASC
LIMIT ?`

interface ThumbBackfillCursorV1 {
  after_subject_id: number
}

interface SubjectMediaLargeRow {
  subject_id: number
  r2_image_large_key: string
}

export interface ThumbBackfillEnv extends ThumbMaterializeEnv {
  AIRING_CAL_D1: D1DatabaseLike
  THUMB_BACKFILL_BATCH?: string
}

function decodeCursor(value: unknown): ThumbBackfillCursorV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { after_subject_id: 0 }
  }
  const candidate = value as Partial<ThumbBackfillCursorV1>
  if (typeof candidate.after_subject_id !== 'number' || !Number.isSafeInteger(candidate.after_subject_id) || candidate.after_subject_id < 0) {
    return { after_subject_id: 0 }
  }
  return { after_subject_id: candidate.after_subject_id }
}

export function parseThumbBackfillBatchLimit(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_THUMB_BACKFILL_BATCH
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_THUMB_BACKFILL_BATCH
  return Math.min(parsed, 50)
}

async function listLargeImageRows(d1: D1DatabaseLike, afterSubjectId: number, limit: number): Promise<SubjectMediaLargeRow[]> {
  const statement = d1.prepare(SUBJECT_MEDIA_LARGE_SELECT).bind(afterSubjectId, limit)
  const result = await statement.all<{ subject_id: number; r2_image_large_key: string }>()
  return result.results ?? []
}

export async function runThumbBackfill(env: ThumbBackfillEnv): Promise<{ results: ThumbGenItemResult[]; summary: ReturnType<typeof summarizeThumbResults>; cursor: ThumbBackfillCursorV1 }> {
  const batchLimit = parseThumbBackfillBatchLimit(env.THUMB_BACKFILL_BATCH)
  const store = new D1StateStore(env.AIRING_CAL_D1)
  const cursor = (await store.getAppState(THUMB_BACKFILL_CURSOR_KEY, decodeCursor)) ?? { after_subject_id: 0 }
  const rows = await listLargeImageRows(env.AIRING_CAL_D1, cursor.after_subject_id, batchLimit)

  const results: ThumbGenItemResult[] = []
  for (const row of rows) {
    const hash = hashFromLargeR2Key(row.r2_image_large_key)
    if (!hash) continue
    results.push(await materializeThumb(hash, env))
  }

  const nextCursor: ThumbBackfillCursorV1 = rows.length > 0
    ? { after_subject_id: rows[rows.length - 1]!.subject_id }
    : { after_subject_id: 0 }

  await store.putAppState(THUMB_BACKFILL_CURSOR_KEY, nextCursor)

  const summary = summarizeThumbResults(results)
  console.log(JSON.stringify({
    stage: 'thumb_backfill',
    batch_limit: batchLimit,
    scanned: rows.length,
    cursor_before: cursor.after_subject_id,
    cursor_after: nextCursor.after_subject_id,
    summary,
  }))

  return { results, summary, cursor: nextCursor }
}

export async function handleThumbBackfillScheduled(_event: ScheduledEvent, env: ThumbBackfillEnv): Promise<void> {
  await runThumbBackfill(env)
}
