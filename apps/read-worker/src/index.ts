export const appBoundary = 'read-worker'

import { imageOriginalKey, imageStatusKey, KVStorage, snapshotActiveKey, snapshotCalendarKey, snapshotCollectionsKey, snapshotSummaryKey, snapshotVersionKey, subjectDetailKey, subjectMetaKey, syncCurrentKey, syncMetaKey, syncRunKey, type SnapshotManifest, type SyncRun } from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'

interface ReadEnv {
  AIRING_CAL_KV: {
    get(key: string, type: 'json'): Promise<unknown>
    put(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
    list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete?: boolean; cursor?: string }>
  }
  AIRING_CAL_R2: {
    get(key: string): Promise<{
      arrayBuffer(): Promise<ArrayBuffer>
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    } | null>
  }
  NSFW_SHOW?: 'true' | 'false'
}

const COLLECTION_TYPES = ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const
const CRON_INTERVAL_HOURS = 4
const HYDRATION_CONCURRENCY = 8
const WORKFLOW_STALE_SECONDS = 20 * 60

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      'Cache-Control': 'public, max-age=60',
      ...(init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers as Record<string, string> | undefined),
    },
  })
}

function validCollectionType(value: string | null): (typeof COLLECTION_TYPES)[number] {
  return COLLECTION_TYPES.includes(value as any) ? value as (typeof COLLECTION_TYPES)[number] : 'watching'
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function collectionLimit(value: string | null): number {
  return Math.min(100, positiveInteger(value, 24))
}

function sanitizeStatus(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeStatus)
  if (!value || typeof value !== 'object') return value
  const sanitized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'source_url') continue
    sanitized[key] = (key === 'last_error' || key === 'error') && item ? sanitizeErrorMessage(item) : sanitizeStatus(item)
  }
  return sanitized
}

async function mapConcurrent<T, R>(values: Iterable<T>, concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const items = [...values]
  const results = new Array<R>(items.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await mapper(items[current])
    }
  }))
  return results
}

type ActiveSnapshot = SnapshotManifest

class SnapshotIncompleteError extends Error {}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function activeSnapshot(storage: KVStorage): Promise<ActiveSnapshot | null> {
  const active = await storage.get<Record<string, unknown>>(snapshotActiveKey())
  if (!active) return null
  const hasManifestFields = 'generation' in active || 'required_keys' in active || 'digests' in active
  if (!hasManifestFields) {
    const legacyKeys = ['instance_id', 'mode', 'published_at', 'subject_count']
    const isLegacyPointer = Object.keys(active).length === legacyKeys.length
      && legacyKeys.every((key) => key in active)
      && typeof active.instance_id === 'string' && active.instance_id.length > 0
      && active.mode === 'live'
      && typeof active.published_at === 'number' && Number.isFinite(active.published_at)
      && typeof active.subject_count === 'number' && Number.isInteger(active.subject_count) && active.subject_count >= 0
    if (isLegacyPointer) return null
    throw new SnapshotIncompleteError()
  }
  if (typeof active.instance_id !== 'string' || !active.instance_id || typeof active.generation !== 'number'
    || active.mode !== 'live' || !Array.isArray(active.required_keys) || !active.required_keys.length
    || active.required_keys.some((key) => typeof key !== 'string')
    || !active.digests || typeof active.digests !== 'object' || Array.isArray(active.digests)) throw new SnapshotIncompleteError()
  const instanceId = active.instance_id
  const requiredKeys = active.required_keys as string[]
  const digests = active.digests as Record<string, unknown>
  const expectedKeys = [
    ...COLLECTION_TYPES.map((type) => snapshotVersionKey(instanceId, `collections:${type}`)),
    snapshotVersionKey(instanceId, 'summary'),
    snapshotVersionKey(instanceId, 'calendar'),
  ]
  if (requiredKeys.length !== expectedKeys.length
    || new Set(requiredKeys).size !== expectedKeys.length
    || expectedKeys.some((key) => !requiredKeys.includes(key))) throw new SnapshotIncompleteError()
  for (const key of expectedKeys) {
    if (typeof digests[key] !== 'string') throw new SnapshotIncompleteError()
    const value = await storage.get(key)
    if (value === null || await digest(value) !== digests[key]) throw new SnapshotIncompleteError()
  }
  return active as unknown as ActiveSnapshot
}

function activeSnapshotInstanceFrom(active: ActiveSnapshot | null): string | null {
  return active?.instance_id ?? null
}

async function activeSnapshotInstance(storage: KVStorage): Promise<string | null> {
  return activeSnapshotInstanceFrom(await activeSnapshot(storage))
}

async function readSnapshot<T>(storage: KVStorage, activeInstance: string | null, suffix: string, legacyKey: string): Promise<T | null> {
  if (activeInstance) {
    const versioned = await storage.get<T>(snapshotVersionKey(activeInstance, suffix))
    if (versioned === null) throw new SnapshotIncompleteError()
    return versioned
  }
  return storage.get<T>(legacyKey)
}

function cachedImageRef(status: any) {
  return status?.status === 'cached' && status.hash && status.uri && status.r2_key
    ? { hash: status.hash, uri: status.uri, r2_key: status.r2_key }
    : null
}

function imageStatus(status: any): string {
  return typeof status?.status === 'string' ? status.status : 'pending_next_cron'
}

function nextCronAt(now = Date.now()): string {
  const next = new Date(now)
  next.setUTCMinutes(0, 0, 0)
  if (next.getTime() <= now) next.setUTCHours(next.getUTCHours() + 1)
  while (next.getUTCHours() % CRON_INTERVAL_HOURS !== 0) {
    next.setUTCHours(next.getUTCHours() + 1)
  }
  return next.toISOString()
}

function cronLastStatus(meta: { synced_at?: number; cron?: { last?: unknown } } | null | undefined): unknown {
  const last = meta?.cron?.last
  if (last && typeof last === 'object' && (last as { status?: unknown }).status !== 'skipped') return last
  if (meta?.synced_at) {
    return {
      status: 'synced',
      source: 'snapshot',
      completed_at: meta.synced_at,
    }
  }
  return null
}

function scheduledWorkflowCronStatus(workflow: SyncRun | null, fallback: unknown, effectiveStatus?: string): unknown {
  if (!workflow || workflow.source !== 'schedule') return fallback
  return {
    status: effectiveStatus ?? workflow.status,
    source: 'workflow',
    triggered_at: workflow.started_at,
    ...(workflow.completed_at ? { completed_at: workflow.completed_at } : {}),
  }
}

function positiveEpisodeCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && value > 0) return value
  }
}

async function hydrateCollectionImages(data: unknown[], env: ReadEnv): Promise<unknown[]> {
  return mapConcurrent(data, HYDRATION_CONCURRENCY, async (entry: any) => {
    if (!entry || typeof entry !== 'object' || typeof entry.subject_id !== 'number') return entry
    const status = await env.AIRING_CAL_KV.get(imageStatusKey(entry.subject_id), 'json')
    if (!status) return entry
    return {
      ...entry,
      images: {
        common: cachedImageRef((status as any).common),
        large: cachedImageRef((status as any).large),
      },
      image_status: {
        common: imageStatus((status as any).common),
        large: imageStatus((status as any).large),
      },
    }
  })
}

async function hydrateCalendarImages(days: unknown[], env: ReadEnv): Promise<unknown[]> {
  const hydrated: unknown[] = []
  for (const day of days as any[]) {
    if (!day || typeof day !== 'object' || !Array.isArray(day.items)) {
      hydrated.push(day)
      continue
    }
    const items = await mapConcurrent(day.items, HYDRATION_CONCURRENCY, async (entry: any) => {
      if (!entry || typeof entry !== 'object') return entry
      const subjectId = typeof entry.subject_id === 'number' ? entry.subject_id : entry.id
      if (typeof subjectId !== 'number') return entry
      const [status, meta, detailEntry] = await Promise.all([
        env.AIRING_CAL_KV.get(imageStatusKey(subjectId), 'json'),
        env.AIRING_CAL_KV.get(subjectMetaKey(subjectId), 'json'),
        env.AIRING_CAL_KV.get(subjectDetailKey(subjectId), 'json'),
      ])
      if (!status && !meta && !detailEntry) return entry
      const detail = (detailEntry as any)?.subject
      const eps = positiveEpisodeCount(detail?.eps, detail?.eps_count, detail?.total_episodes, entry.eps, entry.eps_count, entry.total_episodes)
      const totalEpisodes = positiveEpisodeCount(detail?.total_episodes, detail?.eps, detail?.eps_count, entry.total_episodes, entry.eps, entry.eps_count)
      return {
        ...entry,
        ...(eps ? { eps } : {}),
        ...(totalEpisodes ? { total_episodes: totalEpisodes } : {}),
        ...(detail?.rating ? { rating: detail.rating } : {}),
        images: status
          ? {
              common: cachedImageRef((status as any).common),
              large: cachedImageRef((status as any).large),
            }
          : entry.images,
        image_status: status
          ? {
              common: imageStatus((status as any).common),
              large: imageStatus((status as any).large),
            }
          : entry.image_status,
        nsfw: (meta as any)?.nsfw ?? entry.nsfw,
      }
    })
    hydrated.push({ ...day, items })
  }
  return hydrated
}

async function handleCollections(url: URL, env: ReadEnv): Promise<Response> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const type = validCollectionType(url.searchParams.get('type'))
  const activeInstance = await activeSnapshotInstance(storage)
  const data = await readSnapshot<unknown[]>(storage, activeInstance, `collections:${type}`, snapshotCollectionsKey(type)) ?? []
  const page = positiveInteger(url.searchParams.get('page'), 1)
  const limit = collectionLimit(url.searchParams.get('limit'))
  const start = (page - 1) * limit
  const pageData = data.slice(start, start + limit)
  const types = await readSnapshot<Record<string, number>>(storage, activeInstance, 'summary', snapshotSummaryKey()) ?? {}
  const hydrated = await hydrateCollectionImages(pageData, env)
  return json({ data: hydrated, total: data.length, page, limit, types })
}

async function handleCalendar(env: ReadEnv): Promise<Response> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const activeInstance = await activeSnapshotInstance(storage)
  const data = await readSnapshot<unknown[]>(storage, activeInstance, 'calendar', snapshotCalendarKey()) ?? []
  return json(await hydrateCalendarImages(data, env))
}

async function handleCache(url: URL, env: ReadEnv): Promise<Response> {
  const limit = collectionLimit(url.searchParams.get('limit'))
  const cursor = url.searchParams.get('cursor') ?? undefined
  const list = await env.AIRING_CAL_KV.list?.({ prefix: 'image:status:', limit, cursor })
  const entries = (await mapConcurrent(list?.keys ?? [], HYDRATION_CONCURRENCY, async (key) => {
    const status = await env.AIRING_CAL_KV.get(key.name, 'json')
    return status ? sanitizeStatus(status) : null
  })).filter(Boolean)
  const counts = {
    cached: 0,
    pending_next_cron: 0,
    queued: 0,
    failed: 0,
    missing_source: 0,
  }
  const common = { ...counts }
  const large = { ...counts }
  for (const entry of entries as any[]) {
    if (entry.common?.status && entry.common.status in common) common[entry.common.status as keyof typeof common]++
    if (entry.large?.status && entry.large.status in large) large[entry.large.status as keyof typeof large]++
  }
  return json({
    total_subjects: entries.length,
    common,
    large,
    items: entries,
    cursor: list?.list_complete === false && list.cursor ? list.cursor : null,
  })
}

async function handleHealth(env: ReadEnv): Promise<Response> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const active = await activeSnapshot(storage)
  const activeInstance = activeSnapshotInstanceFrom(active)
  const types = await readSnapshot<Record<string, number>>(storage, activeInstance, 'summary', snapshotSummaryKey())
  const meta = await storage.get<{ synced_at?: number; users?: string[]; cron?: { last?: unknown }; workflow_instance_id?: string; workflow_stage?: string }>(syncMetaKey())
  const current = await storage.get<{ instance_id?: unknown }>(syncCurrentKey())
  const workflowInstanceId = typeof current?.instance_id === 'string' && current.instance_id
    ? current.instance_id
    : meta?.workflow_instance_id ?? activeInstance
  const workflowRun = workflowInstanceId ? await storage.get<SyncRun>(syncRunKey(workflowInstanceId)) : null
  const workflowStale = Boolean(workflowRun && ['queued', 'running', 'retrying'].includes(workflowRun.status) && nowSeconds() - workflowRun.heartbeat_at > WORKFLOW_STALE_SECONDS)
  const effectiveWorkflowStatus = workflowRun ? workflowStale ? 'stale' : workflowRun.status : undefined
  const workflow = workflowRun
    ? sanitizeStatus({
        ...workflowRun,
        status: effectiveWorkflowStatus,
        stale: workflowStale,
      })
    : null
  return json({
    ok: true,
    worker: 'read-worker',
    data: types && typeof types._total === 'number' && types._total > 0
      ? {
          collections: {
            types,
            updated_at: typeof active?.published_at === 'number'
              ? new Date(active.published_at * 1000).toISOString()
              : meta?.synced_at ? new Date(meta.synced_at * 1000).toISOString() : null,
            users: meta?.users ?? [],
          },
          cache: {
            total_subjects: types._total,
            source: 'snapshot_summary',
          },
          cron: {
            next_at: nextCronAt(),
            last: scheduledWorkflowCronStatus(workflowRun, cronLastStatus(meta), effectiveWorkflowStatus),
          },
          workflow,
        }
      : null,
  })
}

async function handleImage(pathname: string, env: ReadEnv): Promise<Response> {
  const hash = pathname.split('/').pop() ?? ''
  if (!/^[0-9a-f]{64}$/i.test(hash)) return new Response('Invalid hash', { status: 400 })
  const object = await env.AIRING_CAL_R2.get(imageOriginalKey(hash))
  if (!object) return new Response('Not found', { status: 404 })
  const headers = new Headers({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
  })
  const bytes = object.customMetadata?.bytes
  if (bytes) headers.set('X-Image-Bytes', bytes)
  return new Response(await object.arrayBuffer(), { headers })
}

async function fetch(request: Request, env: ReadEnv): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (url.pathname === '/collections') return await handleCollections(url, env)
    if (url.pathname === '/calendar') return await handleCalendar(env)
    if (url.pathname === '/config') return json({ nsfw: env.NSFW_SHOW !== 'false' })
    if (url.pathname === '/health') return await handleHealth(env)
    if (url.pathname === '/cache') return await handleCache(url, env)
    if (url.pathname.startsWith('/image/')) return await handleImage(url.pathname, env)
    return new Response('Not found', { status: 404 })
  } catch (error) {
    if (error instanceof SnapshotIncompleteError) {
      return json({ ok: false, error: { code: 'SNAPSHOT_INCOMPLETE', message: 'Active snapshot is incomplete' } }, { status: 503 })
    }
    throw error
  }
}

export default { fetch }
