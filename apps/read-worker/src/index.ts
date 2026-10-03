import { parsePublicSnapshotManifestV1, type PublicSnapshotManifestV1 } from '@airing-cal/domain'
import { publicError } from '@airing-cal/worker-common'
import { snapshotResponse, type SnapshotBucket, type SnapshotCache } from './r2-snapshot.ts'

interface ReadEnv {
  AIRING_CAL_DATA_R2: SnapshotBucket
  AIRING_CAL_R2: {
    get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>
  }
  NSFW_SHOW?: string
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

function edgeCache(): SnapshotCache {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  return {
    match: async (request) => cache?.match(request),
    put: async (request, response) => { await cache?.put(request, response) },
  }
}

async function manifest(env: ReadEnv): Promise<PublicSnapshotManifestV1 | null> {
  const object = await env.AIRING_CAL_DATA_R2.get('public/manifest.json')
  return object ? parsePublicSnapshotManifestV1(JSON.parse(await object.text())) : null
}

async function status(env: ReadEnv): Promise<Record<string, unknown> | null> {
  const object = await env.AIRING_CAL_DATA_R2.get('public/status.json')
  if (!object) return null
  const value = JSON.parse(await object.text())
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1
    || !['running', 'ok', 'error'].includes(value.status) || typeof value.stage !== 'string'
    || !/^[a-z0-9_]+$/.test(value.stage)) throw new Error('Invalid collection status')
  for (const key of ['started_at', 'completed_at', 'observed_at', 'published_at', 'generation']) {
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new Error('Invalid collection status')
  }
  if (value.error_code !== null && (typeof value.error_code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(value.error_code))) {
    throw new Error('Invalid collection status')
  }
  // Only expose the declared public fields, never a job's arbitrary output.
  const result = Object.fromEntries(['schema_version', 'status', 'stage', 'started_at', 'completed_at', 'observed_at', 'published_at', 'generation', 'error_code'].map((key) => [key, value[key]]))
  if (value.counts !== undefined) {
    if (!value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)) throw new Error('Invalid collection counts')
    const counts = Object.fromEntries(['collections', 'subjects', 'media_succeeded', 'media_failed']
      .filter(key => Object.hasOwn(value.counts, key)).map(key => [key, value.counts[key]]))
    if (Object.values(counts).some(count => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid collection counts')
    result.counts = counts
  }
  return result
}

async function image(request: Request, env: ReadEnv): Promise<Response> {
  const hash = new URL(request.url).pathname.slice('/image/'.length)
  if (!/^[0-9a-f]{64}$/.test(hash)) return json({ ok: false, error: { code: 'INVALID_IMAGE' } }, 400)
  const cache = edgeCache()
  const key = new Request(new URL(`/image/${hash}`, request.url))
  try { const cached = await cache.match(key); if (cached?.ok) return cached } catch { /* Read R2 on cache failure. */ }
  const object = await env.AIRING_CAL_R2.get(`images/${hash}/original`)
  if (!object) return json({ ok: false, error: { code: 'IMAGE_NOT_FOUND' } }, 404)
  const response = new Response(await object.arrayBuffer(), { headers: {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
    'ETag': `"${hash}"`,
    'X-Content-Type-Options': 'nosniff',
  } })
  try { await cache.put(key, response.clone()) } catch { /* Best effort edge cache. */ }
  return response
}

function positive(query: URLSearchParams, key: string, fallback: number, maximum: number): number {
  const values = query.getAll(key)
  if (values.length === 0) return fallback
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0])) throw new RangeError('Invalid query')
  const value = Number(values[0])
  if (!Number.isSafeInteger(value) || value > maximum) throw new RangeError('Invalid query')
  return value
}

async function fetch(request: Request, env: ReadEnv): Promise<Response> {
  if (request.method !== 'GET') return json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED' } }, 405)
  const url = new URL(request.url)
  try {
    if (url.pathname === '/config') return json({ nsfw: env.NSFW_SHOW !== 'false' })
    if (url.pathname === '/status') return json(await status(env))
    if (url.pathname.startsWith('/image/')) return await image(request, env)
    if (url.pathname.startsWith('/snapshots/v1/')) {
      return await snapshotResponse(url.pathname.slice(1), env.AIRING_CAL_DATA_R2, edgeCache(), url.origin)
    }
    if (!['/manifest', '/health', '/collections', '/calendar', '/cache'].includes(url.pathname)) return json({ ok: false, error: { code: 'NOT_FOUND' } }, 404)
    const latest = await manifest(env)
    if (!latest) return json({ ok: false, error: { code: 'NO_PUBLISHED_SNAPSHOT' } }, 503)
    if (url.pathname === '/manifest') return json(latest)
    const response = await snapshotResponse(latest.snapshot_key, env.AIRING_CAL_DATA_R2, edgeCache(), url.origin)
    if (!response.ok) return json({ ok: false, error: { code: 'SNAPSHOT_UNAVAILABLE' } }, 503)
    const snapshot = await response.json() as { collections: Record<string, unknown[]>; calendar: unknown[]; summary: Record<string, number>; published_at: number }
    if (snapshot.published_at * 1000 !== Date.parse(latest.published_at) || snapshot.summary._total !== latest.item_count) throw new Error('Manifest snapshot mismatch')
    if (url.pathname === '/health') return json({ ok: true, worker: 'read-worker', data: {
      collections: { types: snapshot.summary, updated_at: latest.published_at },
      cache: { total_subjects: latest.item_count },
      collection_status: await status(env),
    } })
    if (url.pathname === '/calendar') return json(snapshot.calendar)
    if (url.pathname === '/cache') return json({ ok: true, total_subjects: latest.item_count, generation: latest.generation })
    const types = url.searchParams.getAll('type')
    const type = types.length === 0 ? 'watching' : types[0]
    if (types.length > 1 || !Object.hasOwn(snapshot.collections, type)) throw new RangeError('Invalid query')
    const page = positive(url.searchParams, 'page', 1, Number.MAX_SAFE_INTEGER)
    const limit = positive(url.searchParams, 'limit', 24, 100)
    const entries = snapshot.collections[type]
    return json({ data: entries.slice((page - 1) * limit, page * limit), total: entries.length, page, limit, types: snapshot.summary, generation: latest.generation })
  } catch (error) {
    return publicError(error instanceof RangeError ? 400 : 503, error instanceof RangeError ? 'INVALID_REQUEST' : 'REQUEST_FAILED', error)
  }
}

export default { fetch }
