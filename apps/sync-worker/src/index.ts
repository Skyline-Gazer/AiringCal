export const appBoundary = 'sync-worker'

import { BgmClient, BgmHttpError, BgmPlatformClient, fetchAllCollections } from '@airing-cal/bgm-api'
import { compareAccounts, executeSync, imageRefsFromStatus, mergeCollections, subjectDetailImages, transformCalendar, withSubjectDetail, type SubjectDetailMap, type SubjectImages, type SubjectMeta } from '@airing-cal/domain'
import { getCachedSubjectDetail, imageStatusKey, KVStorage, snapshotCalendarKey, snapshotCollectionsKey, snapshotSummaryKey, subjectDetailKey, subjectMetaKey, syncMetaKey } from '@airing-cal/storage'

interface SyncEnv {
  AIRING_CAL_KV: {
    get(key: string, type: 'json'): Promise<unknown>
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
    delete(key: string): Promise<void>
  }
  MEDIA_QUEUE: { send(message: unknown): Promise<void> }
  BANGUMI_TOKEN: string
  BANGUMI_USERS: string
  SYNC_MODE?: 'merge'
}

interface QueueBatch {
  messages: Array<{ body: unknown; ack?: () => void }>
}

const COLLECTION_TYPES = ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const
const SYNC_OPERATION_PREFIX = 'sync:operation:'
const SYNC_OPERATION_TTL_SECONDS = 60 * 60 * 24
const SUBJECT_DETAIL_CONCURRENCY = 8
const CACHE_LOAD_CONCURRENCY = 32
const CRON_SCHEDULE = '0 * * * *'
const EFFECTIVE_CRON_SCHEDULE = '0 */4 * * *'

interface SubjectInput {
  subject_id: number
  title: string
  images: { common?: string; large?: string }
}

interface SyncWarning {
  stage: 'subject_details'
  subject_ids: number[]
  errors: Array<{
    subject_id: number
    name: string
    message: string
    upstream_status?: number
  }>
}

function isDeploySyncMessage(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as { type?: unknown }).type === 'deploy-sync')
}

interface SyncOperationLog {
  id: string
  event: 'sync_operation'
  mode: string
  requested_count: number
  returned_count: number
  ok: number
  errors: number
  duration_ms: number
  at: string
  items: Array<{
    externalId: string
    title: string
    status: 'ok' | 'error'
    collectionStatus?: { before: string; after: string }
    scoreChange?: { before: number | null; after: number | null }
    episodeChanged?: number
    episodeProgress?: { before: number; after: number; total: number }
    error?: string
  }>
}

function usersFromEnv(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

function hasImageSource(images: { common?: string; large?: string }): boolean {
  return Boolean(images.common || images.large)
}

function hasCachedImage(refs: SubjectImages, size: 'common' | 'large'): boolean {
  return refs[size] !== null
}

function emptyImageStatus() {
  return {
    status: 'pending_next_cron',
    hash: null,
    uri: null,
    r2_key: null,
    queued_at: null,
    cached_at: null,
    last_error: null,
  }
}

function queuedImageStatus(sourceUrl: string | undefined, previous: any, now: number) {
  if (previous?.status === 'cached') return previous
  if (!sourceUrl) return { ...emptyImageStatus(), status: 'missing_source' }
  return { ...emptyImageStatus(), status: 'queued', queued_at: now }
}

function operationLogKey(id: string): string {
  return `${SYNC_OPERATION_PREFIX}${id}`
}

function createOperationId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function isOperationId(id: string): boolean {
  return /^[0-9a-z]+-[0-9a-f]{16}$/i.test(id)
}

function warningError(subjectId: number, error: unknown): SyncWarning['errors'][number] {
  const message = error instanceof Error ? error.message : String(error)
  return {
    subject_id: subjectId,
    name: error instanceof Error ? error.name : 'Error',
    message,
    ...(error instanceof BgmHttpError ? { upstream_status: error.status } : {}),
  }
}

async function mapConcurrent<T, R>(items: Iterable<T>, concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const list = [...items]
  const results = new Array<R>(list.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (nextIndex < list.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(list[index])
    }
  })
  await Promise.all(workers)
  return results
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers as Record<string, string> | undefined),
    },
  })
}

function errorJson(error: unknown, status = 500): Response {
  return json({
    ok: false,
    error: {
      code: status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  }, { status })
}

function syncOperationHeaders(id: string): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' })
  headers.set('X-Sync-Operation-Id', id)
  headers.set('X-Sync-Operation-Url', `/api/check/${id}`)
  return headers
}

function createSyncOperationLog(id: string, mode: string, requestedCount: number, results: any[], durationMs: number): SyncOperationLog {
  const ok = results.filter((result) => result.status === 'ok').length
  const errors = results.filter((result) => result.status === 'error').length
  return {
    id,
    event: 'sync_operation',
    mode,
    requested_count: requestedCount,
    returned_count: results.length,
    ok,
    errors,
    duration_ms: durationMs,
    at: new Date().toISOString(),
    items: results.map((result) => ({
      externalId: result.externalId,
      title: result.title,
      status: result.status,
      ...(result.collectionStatus ? { collectionStatus: result.collectionStatus } : {}),
      ...(result.scoreChange ? { scoreChange: result.scoreChange } : {}),
      ...(typeof result.episodeChanged === 'number' ? { episodeChanged: result.episodeChanged } : {}),
      ...(result.episodeProgress ? { episodeProgress: result.episodeProgress } : {}),
      ...(result.error ? { error: result.error } : {}),
    })),
  }
}

async function persistSyncOperationLog(env: SyncEnv, log: SyncOperationLog): Promise<void> {
  await env.AIRING_CAL_KV.put(operationLogKey(log.id), JSON.stringify(log), { expirationTtl: SYNC_OPERATION_TTL_SECONDS })
}

function getPlatformClient(platform: string): BgmPlatformClient {
  if (platform === 'bgm' || !platform) return new BgmPlatformClient()
  throw new Error(`Unsupported platform: ${platform}`)
}

function collectSubjectInputs(collections: any[], calendar: any[], subjectDetails?: SubjectDetailMap): Map<number, SubjectInput> {
  const inputs = new Map<number, SubjectInput>()
  for (const collection of collections) {
    const detail = subjectDetails?.get(collection.subject_id)
    inputs.set(collection.subject_id, {
      subject_id: collection.subject_id,
      title: detail?.name_cn || detail?.name || collection.subject?.name_cn || collection.subject?.name || String(collection.subject_id),
      images: subjectDetailImages(detail ?? collection.subject),
    })
  }
  for (const day of calendar) {
    for (const subject of day.items ?? []) {
      if (inputs.has(subject.id)) continue
      inputs.set(subject.id, {
        subject_id: subject.id,
        title: subject.name_cn || subject.name || String(subject.id),
        images: subjectDetailImages(subject),
      })
    }
  }
  return inputs
}

function calendarSubjectIds(calendar: any[]): number[] {
  const seen = new Set<number>()
  for (const day of calendar) {
    for (const subject of day.items ?? []) {
      if (typeof subject.id !== 'number' || seen.has(subject.id)) continue
      seen.add(subject.id)
    }
  }
  return [...seen]
}

async function loadSubjectDetails(storage: KVStorage, client: BgmClient, subjectIds: number[], now: number): Promise<{ details: Map<number, any>; warnings: SyncWarning[] }> {
  const map = new Map<number, any>()
  const errors: SyncWarning['errors'] = []
  for (let index = 0; index < subjectIds.length; index += SUBJECT_DETAIL_CONCURRENCY) {
    const chunk = subjectIds.slice(index, index + SUBJECT_DETAIL_CONCURRENCY)
    const details = await Promise.all(chunk.map(async (subjectId) => {
      try {
        return [subjectId, await getCachedSubjectDetail(storage, client, subjectId, now)] as const
      } catch (error) {
        errors.push(warningError(subjectId, error))
        return [subjectId, null] as const
      }
    }))
    for (const [subjectId, detail] of details) {
      if (detail) map.set(subjectId, detail)
    }
  }
  return {
    details: map,
    warnings: errors.length
      ? [{ stage: 'subject_details', subject_ids: errors.map((error) => error.subject_id), errors }]
      : [],
  }
}

async function loadStoredSubjectDetails(storage: KVStorage, subjectIds: number[]): Promise<Map<number, any>> {
  const map = new Map<number, any>()
  const cachedEntries = await mapConcurrent(subjectIds, CACHE_LOAD_CONCURRENCY, async (subjectId) => {
    const cached = await storage.get<{ subject?: any }>(subjectDetailKey(subjectId))
    return [subjectId, cached?.subject ?? null] as const
  })
  for (const [subjectId, subject] of cachedEntries) {
    if (subject) map.set(subjectId, subject)
  }
  return map
}

function enrichCalendarWithSubjectDetails(calendar: any[], details: SubjectDetailMap): any[] {
  return calendar.map((day) => ({
    ...day,
    items: (day.items ?? []).map((subject: any) => withSubjectDetail(subject, details.get(subject.id) ?? null)),
  }))
}

async function loadImageMap(storage: KVStorage, subjectIds: Iterable<number>): Promise<Map<number, SubjectImages>> {
  const map = new Map<number, SubjectImages>()
  const imageEntries = await mapConcurrent(subjectIds, CACHE_LOAD_CONCURRENCY, async (subjectId) => {
    const status = await storage.get<any>(imageStatusKey(subjectId))
    return [subjectId, imageRefsFromStatus(status)] as const
  })
  for (const [subjectId, images] of imageEntries) {
    map.set(subjectId, images)
  }
  return map
}

async function markMediaQueued(storage: KVStorage, input: SubjectInput, now: number): Promise<void> {
  const previousStatus = await storage.get<any>(imageStatusKey(input.subject_id))
  await storage.put(imageStatusKey(input.subject_id), {
    subject_id: input.subject_id,
    title: input.title,
    common: queuedImageStatus(input.images.common, previousStatus?.common, now),
    large: queuedImageStatus(input.images.large, previousStatus?.large, now),
    subject_checked_at: previousStatus?.subject_checked_at ?? null,
  })
}

async function sendMediaJob(env: SyncEnv, input: SubjectInput): Promise<void> {
  await env.MEDIA_QUEUE.send({
    subject_id: input.subject_id,
    title: input.title,
    subject_meta: true,
    images: input.images,
  })
}

async function enqueueCalendarMediaEarly(env: SyncEnv, storage: KVStorage, subjectInputs: Map<number, SubjectInput>, calendar: any[], now: number): Promise<Set<number>> {
  const seen = new Set<number>()
  for (const day of calendar) {
    for (const subject of day.items ?? []) {
      if (typeof subject.id !== 'number' || seen.has(subject.id)) continue
      const input = subjectInputs.get(subject.id)
      if (!input) continue
      await markMediaQueued(storage, input, now)
      await sendMediaJob(env, input)
      seen.add(subject.id)
    }
  }
  return seen
}

async function loadSubjectMetaMap(storage: KVStorage, subjectIds: Iterable<number>): Promise<Map<number, Pick<SubjectMeta, 'nsfw'>>> {
  const map = new Map<number, Pick<SubjectMeta, 'nsfw'>>()
  const metaEntries = await mapConcurrent(subjectIds, CACHE_LOAD_CONCURRENCY, async (subjectId) => {
    const meta = await storage.get<SubjectMeta>(subjectMetaKey(subjectId))
    return [subjectId, meta ? { nsfw: meta.nsfw } : null] as const
  })
  for (const [subjectId, meta] of metaEntries) {
    if (meta) map.set(subjectId, meta)
  }
  return map
}

function shouldQueueMedia(input: SubjectInput, images: SubjectImages | undefined, hasMeta: boolean): boolean {
  if (!hasMeta) return true
  if (input.images.common && !hasCachedImage(images ?? { common: null, large: null }, 'common')) return true
  if (input.images.large && !hasCachedImage(images ?? { common: null, large: null }, 'large')) return true
  return false
}

async function runScheduledSync(env: SyncEnv): Promise<SyncWarning[]> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const client = new BgmClient(env.BANGUMI_TOKEN)
  const now = Math.floor(Date.now() / 1000)
  const warnings: SyncWarning[] = []
  const users = usersFromEnv(env.BANGUMI_USERS)
  if (!users.length) throw new Error('sync-worker: BANGUMI_USERS is empty')

  const collectionGroups = await Promise.all(users.map((user) => fetchAllCollections(client, user)))
  const collections = collectionGroups.flat()
  const rawCalendar = await client.getCalendar() as any[]
  const collectionSubjectIds = collections.map((collection: any) => collection.subject_id).filter((subjectId: unknown): subjectId is number => typeof subjectId === 'number')
  const { details: calendarDetails, warnings: detailWarnings } = await loadSubjectDetails(storage, client, calendarSubjectIds(rawCalendar), now)
  warnings.push(...detailWarnings)
  const storedCollectionDetails = await loadStoredSubjectDetails(storage, collectionSubjectIds)
  const subjectDetails = new Map([...storedCollectionDetails, ...calendarDetails])
  const calendar = enrichCalendarWithSubjectDetails(rawCalendar, subjectDetails)
  const subjectInputs = collectSubjectInputs(collections as any[], calendar as any[], subjectDetails)
  const earlyMediaSubjectIds = await enqueueCalendarMediaEarly(env, storage, subjectInputs, calendar as any[], now)
  const subjectIds = [...subjectInputs.keys()]
  const [imageMap, subjectMetaMap] = await Promise.all([
    loadImageMap(storage, subjectIds),
    loadSubjectMetaMap(storage, subjectIds),
  ])
  const merged = mergeCollections(collections as any[], imageMap, subjectMetaMap, subjectDetails)
  const calendarSnapshot = transformCalendar(calendar as any[], imageMap, subjectMetaMap)

  const summary: Record<string, number> = {}
  for (const type of COLLECTION_TYPES) {
    const list = merged[type]
    await storage.put(snapshotCollectionsKey(type), list)
    summary[type] = list.length
  }
  summary._total = COLLECTION_TYPES.reduce((total, type) => total + summary[type], 0)
  await storage.put(snapshotSummaryKey(), summary)
  if (!detailWarnings.length) {
    await storage.put(snapshotCalendarKey(), calendarSnapshot)
  }
  await storage.put(syncMetaKey(), {
    synced_at: Math.floor(Date.now() / 1000),
    mode: 'merge',
    users,
  })

  for (const input of subjectInputs.values()) {
    if (earlyMediaSubjectIds.has(input.subject_id)) continue
    if (!hasImageSource(input.images) && subjectMetaMap.has(input.subject_id)) continue
    if (!shouldQueueMedia(input, imageMap.get(input.subject_id), subjectMetaMap.has(input.subject_id))) continue
    await markMediaQueued(storage, input, now)
    await sendMediaJob(env, input)
  }

  return warnings
}

async function runDeployCalendarWarmup(env: SyncEnv): Promise<SyncWarning[]> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const client = new BgmClient(env.BANGUMI_TOKEN)
  const now = Math.floor(Date.now() / 1000)
  const warnings: SyncWarning[] = []

  const rawCalendar = await client.getCalendar() as any[]
  const { details: calendarDetails, warnings: detailWarnings } = await loadSubjectDetails(storage, client, calendarSubjectIds(rawCalendar), now)
  warnings.push(...detailWarnings)
  const calendar = enrichCalendarWithSubjectDetails(rawCalendar, calendarDetails)
  const subjectInputs = collectSubjectInputs([], calendar as any[], calendarDetails)
  await enqueueCalendarMediaEarly(env, storage, subjectInputs, calendar as any[], now)
  const subjectIds = [...subjectInputs.keys()]
  const [imageMap, subjectMetaMap] = await Promise.all([
    loadImageMap(storage, subjectIds),
    loadSubjectMetaMap(storage, subjectIds),
  ])
  if (!detailWarnings.length) {
    await storage.put(snapshotCalendarKey(), transformCalendar(calendar as any[], imageMap, subjectMetaMap))
  }
  const current = await storage.get<Record<string, unknown>>(syncMetaKey()) ?? {}
  await storage.put(syncMetaKey(), {
    ...current,
    calendar_synced_at: Math.floor(Date.now() / 1000),
  })
  return warnings
}

async function fetch(request: Request, env: SyncEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/internal/sync/compare' && request.method === 'POST') {
    try {
      const body = await request.json() as any
      const clientA = getPlatformClient(body.platformA || 'bgm')
      const clientB = getPlatformClient(body.platformB || 'bgm')
      return json(await compareAccounts(clientA, body.tokenA || '', clientB, body.tokenB || ''))
    } catch (error) {
      return errorJson(error, error instanceof SyntaxError ? 400 : 500)
    }
  }

  if (url.pathname === '/internal/sync/apply' && request.method === 'POST') {
    const startedAt = Date.now()
    try {
      const body = await request.json() as any
      const operationId = createOperationId()
      const clientA = getPlatformClient(body.platformA || 'bgm')
      const clientB = getPlatformClient(body.platformB || 'bgm')
      const results = await executeSync(clientA, body.tokenA || '', clientB, body.tokenB || '', {
        mode: body.mode,
        from: body.from,
        to: body.to,
        subject_ids: body.subject_ids,
        baseline: body.baseline,
      })
      const requestedCount = Array.isArray(body.subject_ids) ? body.subject_ids.length : results.length
      await persistSyncOperationLog(env, createSyncOperationLog(operationId, body.mode, requestedCount, results, Date.now() - startedAt))
      return json(results, { headers: syncOperationHeaders(operationId) })
    } catch (error) {
      return errorJson(error, error instanceof SyntaxError ? 400 : 500)
    }
  }

  if (url.pathname.startsWith('/internal/check/') && request.method === 'GET') {
    const id = url.pathname.split('/').pop() ?? ''
    if (!isOperationId(id)) return errorJson(new Error('Invalid operation id'), 400)
    const storage = new KVStorage(env.AIRING_CAL_KV)
    const operation = await storage.get<SyncOperationLog>(operationLogKey(id))
    if (!operation) return errorJson(new Error('Operation log not found or expired'), 404)
    if (request.headers.get('accept')?.includes('application/json')) return json({ ok: true, operation })
    return new Response(`<h1>同步操作日志</h1><pre>${JSON.stringify(operation, null, 2)}</pre>`, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  return new Response('Not found', { status: 404 })
}

function shouldRunSync(scheduledTime: number): boolean {
  const hour = new Date(scheduledTime).getUTCHours()
  return hour % 4 === 0
}

async function recordCronStatus(env: SyncEnv, statusKey: 'last' | 'last_skip', status: Record<string, unknown>): Promise<void> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const current = await storage.get<Record<string, unknown>>(syncMetaKey()) ?? {}
  const currentCron = current.cron && typeof current.cron === 'object' ? current.cron as Record<string, unknown> : {}
  await storage.put(syncMetaKey(), {
    ...current,
    cron: {
      ...currentCron,
      schedule: CRON_SCHEDULE,
      effective_schedule: EFFECTIVE_CRON_SCHEDULE,
      [statusKey]: status,
    },
  })
}

async function scheduled(event: { scheduledTime?: number }, env: SyncEnv, ctx: { waitUntil(promise: Promise<unknown>): unknown }): Promise<void> {
  const scheduledTime = event.scheduledTime ?? Date.now()
  const triggeredAt = Math.floor(scheduledTime / 1000)
  if (!shouldRunSync(scheduledTime)) {
    await recordCronStatus(env, 'last_skip', {
      status: 'skipped',
      source: 'scheduled',
      triggered_at: triggeredAt,
      reason: 'outside_effective_schedule',
    })
    return
  }
  try {
    const promise = runScheduledSync(env)
    ctx.waitUntil(promise)
    const warnings = await promise
    await recordCronStatus(env, 'last', {
      status: 'ok',
      source: 'scheduled',
      triggered_at: triggeredAt,
      completed_at: Math.floor(Date.now() / 1000),
      ...(warnings.length ? { warnings } : {}),
    })
  } catch (error) {
    await recordCronStatus(env, 'last', {
      status: 'error',
      source: 'scheduled',
      triggered_at: triggeredAt,
      completed_at: Math.floor(Date.now() / 1000),
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function queue(batch: QueueBatch, env: SyncEnv): Promise<void> {
  for (const message of batch.messages) {
    const triggeredAt = Math.floor(Date.now() / 1000)
    const deploySync = isDeploySyncMessage(message.body)
    await recordCronStatus(env, 'last', {
      status: 'running',
      source: 'queue',
      triggered_at: triggeredAt,
      ...(deploySync ? { mode: 'deploy-calendar' } : {}),
    })
    try {
      let warnings: SyncWarning[] = []
      if (deploySync) {
        warnings = await runDeployCalendarWarmup(env)
      } else {
        warnings = await runScheduledSync(env)
      }
      await recordCronStatus(env, 'last', {
        status: 'ok',
        source: 'queue',
        triggered_at: triggeredAt,
        completed_at: Math.floor(Date.now() / 1000),
        ...(deploySync ? { mode: 'deploy-calendar' } : {}),
        ...(warnings.length ? { warnings } : {}),
      })
      message.ack?.()
    } catch (error) {
      await recordCronStatus(env, 'last', {
        status: 'error',
        source: 'queue',
        triggered_at: triggeredAt,
        completed_at: Math.floor(Date.now() / 1000),
        ...(deploySync ? { mode: 'deploy-calendar' } : {}),
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

export { runScheduledSync, shouldRunSync }
export default { fetch, scheduled, queue }
