export const appBoundary = 'read-worker'

import { imageOriginalKey, imageStatusKey, KVStorage, snapshotCalendarKey, snapshotCollectionsKey, snapshotSummaryKey, subjectMetaKey, syncMetaKey } from '@airing-cal/storage'
import { sanitizeErrorMessage } from '@airing-cal/worker-common'

interface ReadEnv {
  AIRING_CAL_KV: {
    get(key: string, type: 'json'): Promise<unknown>
    put(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
    list?(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>
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
    sanitized[key] = key === 'last_error' && item ? sanitizeErrorMessage(item) : sanitizeStatus(item)
  }
  return sanitized
}

function cachedImageRef(status: any) {
  return status?.status === 'cached' && status.hash && status.uri && status.r2_key
    ? { hash: status.hash, uri: status.uri, r2_key: status.r2_key }
    : null
}

function imageStatus(status: any): string {
  return typeof status?.status === 'string' ? status.status : 'pending_next_cron'
}

async function hydrateCollectionImages(data: unknown[], env: ReadEnv): Promise<unknown[]> {
  return Promise.all(data.map(async (entry: any) => {
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
  }))
}

async function hydrateCalendarImages(days: unknown[], env: ReadEnv): Promise<unknown[]> {
  return Promise.all(days.map(async (day: any) => {
    if (!day || typeof day !== 'object' || !Array.isArray(day.items)) return day
    const items = await Promise.all(day.items.map(async (entry: any) => {
      if (!entry || typeof entry !== 'object') return entry
      const subjectId = typeof entry.subject_id === 'number' ? entry.subject_id : entry.id
      if (typeof subjectId !== 'number') return entry
      const [status, meta] = await Promise.all([
        env.AIRING_CAL_KV.get(imageStatusKey(subjectId), 'json'),
        env.AIRING_CAL_KV.get(subjectMetaKey(subjectId), 'json'),
      ])
      if (!status && !meta) return entry
      return {
        ...entry,
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
    }))
    return { ...day, items }
  }))
}

async function handleCollections(url: URL, env: ReadEnv): Promise<Response> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const type = validCollectionType(url.searchParams.get('type'))
  const data = await storage.get<unknown[]>(snapshotCollectionsKey(type)) ?? []
  const page = positiveInteger(url.searchParams.get('page'), 1)
  const limit = collectionLimit(url.searchParams.get('limit'))
  const start = (page - 1) * limit
  const pageData = data.slice(start, start + limit)
  const types = await storage.get<Record<string, number>>(snapshotSummaryKey()) ?? {}
  const hydrated = await hydrateCollectionImages(pageData, env)
  return json({ data: hydrated, total: data.length, page, limit, types })
}

async function handleCalendar(env: ReadEnv): Promise<Response> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const data = await storage.get<unknown[]>(snapshotCalendarKey()) ?? []
  return json(await hydrateCalendarImages(data, env))
}

async function handleCache(env: ReadEnv): Promise<Response> {
  const list = await env.AIRING_CAL_KV.list?.({ prefix: 'image:status:' })
  const entries = []
  for (const key of list?.keys ?? []) {
    const status = await env.AIRING_CAL_KV.get(key.name, 'json')
    if (status) entries.push(sanitizeStatus(status))
  }
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
  })
}

async function handleHealth(env: ReadEnv): Promise<Response> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const types = await storage.get<Record<string, number>>(snapshotSummaryKey())
  const meta = await storage.get<{ synced_at?: number; users?: string[] }>(syncMetaKey())
  return json({
    ok: true,
    worker: 'read-worker',
    data: types && typeof types._total === 'number' && types._total > 0
      ? {
          collections: {
            types,
            updated_at: meta?.synced_at ? new Date(meta.synced_at * 1000).toISOString() : null,
            users: meta?.users ?? [],
          },
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
  const url = new URL(request.url)
  if (url.pathname === '/collections') return handleCollections(url, env)
  if (url.pathname === '/calendar') return handleCalendar(env)
  if (url.pathname === '/config') return json({ nsfw: env.NSFW_SHOW !== 'false' })
  if (url.pathname === '/health') return handleHealth(env)
  if (url.pathname === '/cache') return handleCache(env)
  if (url.pathname.startsWith('/image/')) return handleImage(url.pathname, env)
  return new Response('Not found', { status: 404 })
}

export default { fetch }
