import {
  D1StateStore,
  migrateCleanupCursorKey,
  migrateReadModeKey,
  type CleanupCursorV1,
  type CollectionRow,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type ReadModeV1,
} from '@airing-cal/storage'
import {
  createCloudflareD1Client,
  createCloudflareKvClient,
  createR2Store,
  createRunContext,
  readNodeJobsConfig,
  type CloudflareD1Client,
  type RunContext,
} from '../adapters/index.ts'

export const LEGACY_CLEANUP_OBSERVATION_DAYS = 14
export const MAX_LEGACY_KEYS_PER_RUN = 100

const POINTER_KEY = 'public:current'
const DAY_SECONDS = 86_400
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/
const EMPTY_META = {
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
}

export interface LegacyCleanupKv {
  getJson(key: string): Promise<unknown | null>
  delete(key: string): Promise<void>
}

export interface LegacyCleanupDataR2 {
  get(key: string): Promise<Uint8Array | null>
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
    `subject:detail:${subjectId}`,
    `subject:meta:${subjectId}`,
    `image:status:${subjectId}`,
    `subject:refresh:${subjectId}`,
  ]
}

/** Minimal D1DatabaseLike over the CloudflareD1Client HTTP query surface. */
export function createHttpD1Database(client: CloudflareD1Client): D1DatabaseLike {
  function prepare(query: string, params: unknown[] = []): D1PreparedStatementLike {
    return {
      bind(...values: unknown[]) {
        return prepare(query, [...params, ...values])
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const rows = await client.query(query, params)
        return (rows[0] as T | undefined) ?? null
      },
      async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
        const rows = await client.query(query, params)
        return { results: rows as T[], success: true, meta: EMPTY_META }
      },
      async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
        const rows = await client.query(query, params)
        return { results: rows as T[], success: true, meta: EMPTY_META }
      },
      async raw<T = unknown[]>(): Promise<T[]> {
        const rows = await client.query(query, params)
        return rows.map((row) => Object.values(row) as unknown as T) as T[]
      },
    }
  }
  return {
    prepare,
    async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
      const results: D1ResultLike<T>[] = []
      for (const statement of statements) results.push(await statement.run<T>())
      return results
    },
    async exec(query: string) {
      await client.query(query)
      return { count: 0, duration: 0 }
    },
  }
}

export interface LegacyCleanupStore {
  listCollectionRows(): Promise<CollectionRow[]>
  getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined>
  putAppStateIfNewer<T>(key: string, value: T, version: number): Promise<boolean>
}

export async function runLegacyCleanup(
  d1: LegacyCleanupStore,
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
  const pointerValue = await kv.getJson(POINTER_KEY)
  const pointer = isValidPointer(pointerValue) ? pointerValue : null
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

export function parseLegacyCleanupArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true
    else throw new Error(`Unknown argument: ${arg} (supported: --dry-run)`)
  }
  return { dryRun }
}

export async function main(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv.slice(2)): Promise<void> {
  const { dryRun } = parseLegacyCleanupArgs(argv)
  const config = readNodeJobsConfig(env)
  if (!config.kvNamespaceId) throw new Error('AIRING_CAL_KV_NAMESPACE_ID is required for legacy cleanup')
  const deadlineAt = Date.now() + 10 * 60 * 1000
  const run: RunContext = createRunContext({ runId: `legacy-cleanup-${Date.now()}`, deadlineAt })
  const d1Client = createCloudflareD1Client(config, run)
  const store = new D1StateStore(createHttpD1Database(d1Client))
  const kv = createCloudflareKvClient(config, run)
  const dataR2 = createR2Store(config, run)

  const now = Math.floor(Date.now() / 1000)
  if (dryRun) {
    const readMode = await store.getAppState(migrateReadModeKey(), decodeReadMode)
    const switchedAt = readMode?.mode === 'r2' && readMode.switched_at !== null ? readMode.switched_at : null
    const eligible = switchedAt !== null && now - switchedAt >= LEGACY_CLEANUP_OBSERVATION_DAYS * DAY_SECONDS
    const cursor = await store.getAppState(migrateCleanupCursorKey(), decodeCleanupCursor)
    console.log(JSON.stringify({
      status: 'info',
      stage: 'legacy_cleanup_dry_run',
      read_mode: readMode?.mode ?? null,
      switched_at: switchedAt,
      observation_elapsed: eligible,
      cursor: cursor ?? null,
    }))
    return
  }
  const result = await runLegacyCleanup(store, kv, dataR2, now)
  console.log(JSON.stringify({
    status: 'ok',
    stage: 'legacy_cleanup',
    last_subject_id: result.last_subject_id,
    deleted_count: result.deleted_count,
    updated_at: result.updated_at,
  }))
  dataR2.close()
}

if (process.argv[1]?.endsWith('portable-legacy-cleanup.ts')) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : 'legacy_cleanup_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'legacy_cleanup', message }))
    process.exit(1)
  })
}
