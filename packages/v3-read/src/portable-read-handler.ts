import {
  imageOriginalKey,
  imageThumbV1Key,
  imageThumbV2Key,
  sniffImage,
  type PublicSnapshotV1,
} from '@airing-cal/storage'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import type { PublicStore } from '@airing-cal/v3-core/ports'
import {
  publicImageRedirectResponse,
  resolvePublicObjectUrl,
} from '@airing-cal/v3-core/public-image-url'
import { loadVerifiedPublicSnapshot, type VerifiedPublicSnapshot } from './load-public-snapshot.ts'
import { resolveRuntimePlatformIdFromEnv } from '@airing-cal/v3-adapters/platform-id'
import type { PortableCronStatus } from './portable-builder-cron.ts'

const COLLECTION_TYPES = ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const

export interface PortableReadEnv {
  publicStore: PublicStore
  nsfwShow?: boolean
  packageVersion?: string
  /**
   * Validated public CDN/S3 base URL (C6) used to 302 image requests. Handlers
   * validate `AIRINGCAL_PUBLIC_BASE_URL` once at config time and pass the result
   * here; per-request parsing is not part of the contract.
   */
  publicBaseUrl?: string
  /** Platform label for `/version`; e.g. `{ AIRINGCAL_PLATFORM: 'cloudflare' }` in the Workers gateway. */
  processEnv?: Record<string, string | undefined>
  /**
   * Optional `/health` cron source. Compose web passes the SQLite-backed reader; platform
   * gateways without local SQLite omit it. Injected (not imported) so Workers bundles stay free of `node:sqlite`.
   */
  cronStatus?: () => PortableCronStatus
}

class InvalidQueryError extends Error {}

function readPlatformId(processEnv?: Record<string, string | undefined>): string | undefined {
  if (!processEnv) return undefined
  try {
    return resolveRuntimePlatformIdFromEnv(processEnv)
  } catch {
    return processEnv.AIRINGCAL_PLATFORM?.trim() || undefined
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  // EdgeOne edge functions do not implement the static `Response.json()`; build the
  // response explicitly so every runtime (Cloudflare, EdgeOne, Node) behaves the same.
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Cache-Control': V2_CACHE_CONTROL.defaultJson,
      ...(init?.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : (init?.headers as Record<string, string> | undefined)),
    },
  })
}

function singleQueryParameter(searchParams: URLSearchParams, name: string): string | null {
  const values = searchParams.getAll(name)
  if (values.length > 1) throw new InvalidQueryError(`Repeated ${name}`)
  return values[0] ?? null
}

function parseCollectionType(value: string | null): (typeof COLLECTION_TYPES)[number] {
  if (value === null) return 'watching'
  if (!COLLECTION_TYPES.includes(value as (typeof COLLECTION_TYPES)[number])) throw new InvalidQueryError()
  return value as (typeof COLLECTION_TYPES)[number]
}

function parsePositiveInteger(name: string, value: string | null, fallback: number, max?: number): number {
  if (value === null) return fallback
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidQueryError(`Invalid ${name}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || (max !== undefined && parsed > max)) throw new InvalidQueryError(`Invalid ${name}`)
  return parsed
}

export function normalizePortableReadPath(pathname: string): string {
  if (pathname === '/api' || pathname === '/api/') return '/'
  if (pathname.startsWith('/api/')) return pathname.slice(4)
  return pathname
}

async function handleCollections(url: URL, snapshot: PublicSnapshotV1): Promise<Response> {
  const type = parseCollectionType(singleQueryParameter(url.searchParams, 'type'))
  const page = parsePositiveInteger('page', singleQueryParameter(url.searchParams, 'page'), 1)
  const limit = parsePositiveInteger('limit', singleQueryParameter(url.searchParams, 'limit'), 24, 100)
  const data = snapshot.collections[type]
  const start = (page - 1) * limit
  return json({
    data: data.slice(start, start + limit),
    total: data.length,
    page,
    limit,
    types: { ...snapshot.summary },
  }, { headers: { 'Cache-Control': V2_CACHE_CONTROL.collections } })
}

async function handleCalendar(snapshot: PublicSnapshotV1): Promise<Response> {
  return json(snapshot.calendar, { headers: { 'Cache-Control': V2_CACHE_CONTROL.calendar } })
}

async function handleHealth(
  loaded: VerifiedPublicSnapshot,
  env: PortableReadEnv,
): Promise<Response> {
  const publishedAt = loaded.snapshot.published_at
  const cron = env.cronStatus?.() ?? {
    scheduler: 'external' as const,
    next_at: null,
    last: null,
  }
  return json({
    ok: true,
    worker: 'portable-read',
    data: {
      collections: {
        types: { ...loaded.snapshot.summary },
        updated_at: new Date(publishedAt * 1000).toISOString(),
        users: [],
      },
      cache: {
        total_subjects: loaded.snapshot.summary._total ?? 0,
        source: 'public_store',
      },
      cron,
      workflow: null,
      publish: {
        generation: loaded.generation,
        artifact_ref: loaded.artifact_ref,
        content_hash: loaded.content_hash,
      },
    },
  })
}

interface ImageCandidate {
  key: string
  contentType: string
}

/**
 * `/image/:hash` and `/image/:hash/thumb`.
 *
 * A redirect is only emitted for an object that was verified to exist: thumbs
 * are optional (only large covers get `thumb.v2.webp`), so redirecting blindly
 * sent clients to a CDN key that returns 404 with no gateway fallback. Order is
 * thumb.v2 → thumb.v1 → 404 for thumbs, and original → 404 for originals.
 */
async function handleImage(
  pathname: string,
  publicStore: PublicStore,
  publicBaseUrl?: string,
): Promise<Response> {
  const match = pathname.match(/^\/image\/([0-9a-f]{64})(?:\/(thumb))?\/?$/i)
  if (!match?.[1]) return new Response('Invalid hash', { status: 400 })
  const hash = match[1].toLowerCase()
  const isThumb = match[2] === 'thumb'
  const candidates: ImageCandidate[] = isThumb
    ? [
      { key: imageThumbV2Key(hash), contentType: 'image/webp' },
      { key: imageThumbV1Key(hash), contentType: 'image/webp' },
    ]
    : [{ key: imageOriginalKey(hash), contentType: 'application/octet-stream' }]
  for (const candidate of candidates) {
    const redirectTo = resolvePublicObjectUrl(publicBaseUrl, candidate.key)
    if (redirectTo) {
      // Existence probe only: HEAD when the store supports it (C5 port), else a body read.
      const exists = publicStore.headObject
        ? (await publicStore.headObject(candidate.key)) != null
        : (await publicStore.getSnapshotBytes(candidate.key)) != null
      if (exists) return publicImageRedirectResponse(redirectTo)
      continue
    }
    const head = publicStore.headObject ? await publicStore.headObject(candidate.key) : null
    const bytes = await publicStore.getSnapshotBytes(candidate.key)
    if (!bytes) continue
    const contentType =
      (head?.contentType && head.contentType.trim() !== '' ? head.contentType : null)
      ?? sniffImage(bytes)
      ?? candidate.contentType
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': V2_CACHE_CONTROL.image,
        'CDN-Cache-Control': V2_CACHE_CONTROL.imageCdn,
        'Content-Type': contentType,
      },
    })
  }
  return new Response('Not found', { status: 404 })
}

function countImageStatus(snapshot: PublicSnapshotV1) {
  const counts = {
    cached: 0,
    pending_next_cron: 0,
    queued: 0,
    failed: 0,
    missing_source: 0,
  }
  const bump = (status: string | undefined) => {
    if (status && status in counts) counts[status as keyof typeof counts] += 1
  }
  for (const type of COLLECTION_TYPES) {
    for (const item of snapshot.collections[type]) {
      bump(item.image_status?.common)
      bump(item.image_status?.large)
    }
  }
  for (const day of snapshot.calendar) {
    for (const item of day.items) {
      bump(item.image_status?.common)
      bump(item.image_status?.large)
    }
  }
  return { common: { ...counts }, large: { ...counts } }
}

async function handleCache(snapshot: PublicSnapshotV1, url: URL): Promise<Response> {
  const limit = parsePositiveInteger('limit', singleQueryParameter(url.searchParams, 'limit'), 24, 100)
  const common = countImageStatus(snapshot)
  return json({
    page_subjects: Math.min(limit, snapshot.summary._total ?? 0),
    common: common.common,
    large: common.large,
    items: [],
    cursor: null,
  })
}

export async function handlePortableReadRequest(
  request: Request,
  env: PortableReadEnv,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const path = normalizePortableReadPath(url.pathname)
    if (path === '/config') {
      return json({ nsfw: env.nsfwShow !== false }, { headers: { 'Cache-Control': V2_CACHE_CONTROL.config } })
    }
    if (path === '/version') {
      const platform = readPlatformId(env.processEnv)
      return json({
        app: 'airingcal',
        read: platform ?? 'portable',
        package: env.packageVersion ?? '0.0.0',
        ...(platform ? { platform } : {}),
      }, { headers: { 'Cache-Control': V2_CACHE_CONTROL.version } })
    }
    const loaded = await loadVerifiedPublicSnapshot(env.publicStore)
    if (!loaded && path !== '/health') {
      return json({ ok: false, error: { code: 'NO_RELEASE', message: 'No verified public release' } }, {
        status: 503,
        headers: { 'Cache-Control': V2_CACHE_CONTROL.error },
      })
    }
    if (path === '/health') {
      if (!loaded) {
        return json({ ok: false, worker: 'portable-read', error: { code: 'NO_RELEASE' } }, {
          status: 503,
          headers: { 'Cache-Control': V2_CACHE_CONTROL.error },
        })
      }
      return handleHealth(loaded, env)
    }
    const snapshot = loaded!.snapshot
    if (path === '/collections') return handleCollections(url, snapshot)
    if (path === '/calendar') return handleCalendar(snapshot)
    if (path === '/cache') return handleCache(snapshot, url)
    if (path.startsWith('/image/')) return handleImage(path, env.publicStore, env.publicBaseUrl)
    return new Response('Not found', { status: 404 })
  } catch (error) {
    if (error instanceof InvalidQueryError) {
      return json({ ok: false, error: { code: 'INVALID_QUERY', message: 'Invalid query parameter' } }, {
        status: 400,
        headers: { 'Cache-Control': V2_CACHE_CONTROL.error },
      })
    }
    throw error
  }
}
