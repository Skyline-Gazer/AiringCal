import {
  imageStatusKey,
  migrateCleanupCursorKey,
  migrateReadModeKey,
  subjectDetailKey,
  subjectMetaKey,
  subjectRefreshKey,
  type CleanupCursorV1,
  type CollectionRow,
  type ReadModeV1,
} from '@airing-cal/storage'

export const LEGACY_CLEANUP_OBSERVATION_DAYS = 14
export const MAX_LEGACY_KEYS_PER_RUN = 100

const POINTER_KEY = 'public:current'
const DAY_SECONDS = 86_400
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/

export interface LegacyCleanupD1 {
  listCollectionRows(): Promise<CollectionRow[]>
  getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined>
  putAppStateIfNewer<T>(key: string, value: T, version: number): Promise<boolean>
}

export interface LegacyCleanupKv {
  get(key: string, type?: 'json'): Promise<unknown>
  delete(key: string): Promise<void>
}

export interface LegacyCleanupDataR2 {
  get(key: string): Promise<{ key: string } | null>
}

function decodeReadMode(value: unknown): ReadModeV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.mode !== 'r2' && candidate.mode !== 'legacy') return undefined
  return {
    mode: candidate.mode,
    switched_at: typeof candidate.switched_at === 'number' ? candidate.switched_at as number : null,
  }
}

function decodeCleanupCursor(value: unknown): CleanupCursorV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.deleted_count)
    || (candidate.deleted_count as number) < 0
    || typeof candidate.updated_at !== 'number') return undefined
  return {
    last_subject_id: typeof candidate.last_subject_id === 'number'
      ? candidate.last_subject_id as number
      : null,
    deleted_count: candidate.deleted_count as number,
    updated_at: candidate.updated_at as number,
  }
}

function isValidPointer(value: unknown): value is { r2_key: string; generation: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.schema_version === 1
    && Number.isSafeInteger(candidate.generation)
    && (candidate.generation as number) >= 0
    && typeof candidate.content_hash === 'string'
    && LOWERCASE_SHA256.test(candidate.content_hash)
    && typeof candidate.r2_key === 'string'
}

function emptyCursor(now: number): CleanupCursorV1 {
  return { last_subject_id: null, deleted_count: 0, updated_at: now }
}

function legacyKeys(subjectId: number): string[] {
  return [
    subjectDetailKey(subjectId),
    subjectMetaKey(subjectId),
    imageStatusKey(subjectId),
    subjectRefreshKey(subjectId),
  ]
}

export async function runLegacyCleanup(
  d1: LegacyCleanupD1,
  kv: LegacyCleanupKv,
  dataR2: LegacyCleanupDataR2,
  now: number,
): Promise<CleanupCursorV1> {
  const readMode = await d1.getAppState(migrateReadModeKey(), decodeReadMode)
  const switchedAt = readMode?.mode === 'r2' && readMode.switched_at !== null
    ? readMode.switched_at
    : null
  if (switchedAt === null || now - switchedAt < LEGACY_CLEANUP_OBSERVATION_DAYS * DAY_SECONDS) {
    return emptyCursor(now)
  }
  const pointer = isValidPointer(await kv.get(POINTER_KEY, 'json'))
    ? await kv.get(POINTER_KEY, 'json') as { r2_key: string }
    : null
  if (pointer === null || await dataR2.get(pointer.r2_key) === null) {
    return emptyCursor(now)
  }

  const cursor = await d1.getAppState(migrateCleanupCursorKey(), decodeCleanupCursor)
  const subjectIds = [...new Set((await d1.listCollectionRows()).map((row) => row.subject_id))]
    .sort((a, b) => a - b)
  const afterSubjectId = cursor?.last_subject_id ?? null
  const startIndex = afterSubjectId === null
    ? 0
    : subjectIds.findIndex((subjectId) => subjectId > afterSubjectId)
  const pending = startIndex === -1 ? [] : subjectIds.slice(startIndex)

  const baseDeletedCount = cursor?.deleted_count ?? 0
  let runDeletedCount = 0
  let lastSubjectId = cursor?.last_subject_id ?? null
  for (const subjectId of pending) {
    const keys = legacyKeys(subjectId)
    if (runDeletedCount + keys.length > MAX_LEGACY_KEYS_PER_RUN) break
    try {
      for (const key of keys) await kv.delete(key)
    } catch {
      break
    }
    runDeletedCount += keys.length
    lastSubjectId = subjectId
    await d1.putAppStateIfNewer(migrateCleanupCursorKey(), {
      last_subject_id: lastSubjectId,
      deleted_count: baseDeletedCount + runDeletedCount,
      updated_at: now,
    } satisfies CleanupCursorV1, now)
  }
  const next: CleanupCursorV1 = {
    last_subject_id: lastSubjectId,
    deleted_count: baseDeletedCount + runDeletedCount,
    updated_at: now,
  }
  await d1.putAppStateIfNewer(migrateCleanupCursorKey(), next, now)
  return next
}
