import {
  parsePublicSnapshotManifestV1,
  parsePublicSnapshotV1,
  type PublicSnapshotManifestV1,
} from '@airing-cal/domain'
import type { PublicSnapshotV1 } from '@airing-cal/storage'

const MANIFEST_KEY = 'public/manifest.json'
const CACHE_PREFIX = 'https://cache.local/r2-snapshot/'
const LAST_VERIFIED_KEY = CACHE_PREFIX + 'last-verified'
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60

export interface ReadSnapshotDataR2 {
  get(key: string): Promise<{ key: string; text(): Promise<string> } | null>
}
export interface ReadSnapshotCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

type VerifiedPair = { manifest: PublicSnapshotManifestV1; snapshot: PublicSnapshotV1 }
type CachePointer = { generation: number; content_sha256: string }

export type SnapshotSource =
  | { mode: 'legacy' }
  | ({ mode: 'r2' } & VerifiedPair)
  | ({ mode: 'cache' } & VerifiedPair)

function cacheRequest(manifest: Pick<PublicSnapshotManifestV1, 'generation' | 'content_sha256'>): Request {
  return new Request(`${CACHE_PREFIX}${manifest.generation}-${manifest.content_sha256}`)
}

function lastVerifiedRequest(): Request {
  return new Request(LAST_VERIFIED_KEY)
}

function cacheResponse(value: unknown, immutable = false): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${CACHE_TTL_SECONDS}${immutable ? ', immutable' : ''}`,
    },
  })
}

function matchesManifest(snapshot: PublicSnapshotV1, manifest: PublicSnapshotManifestV1): boolean {
  const publishedAt = new Date(snapshot.published_at * 1_000)
  return snapshot.generation === manifest.generation
    && snapshot.content_hash === manifest.content_sha256
    && snapshot.summary._total === manifest.item_count
    && Number.isFinite(publishedAt.getTime())
    && publishedAt.toISOString() === manifest.published_at
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCachePointer(value: unknown): CachePointer | null {
  if (!isRecord(value)) return null
  if (Object.keys(value).length !== 2
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || typeof value.content_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.content_sha256)) return null
  return {
    generation: value.generation as number,
    content_sha256: value.content_sha256,
  }
}

async function parseCachedPair(value: unknown, pointer?: CachePointer): Promise<VerifiedPair | null> {
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'manifest')
    || !Object.hasOwn(value, 'snapshot')) return null
  try {
    const manifest = parsePublicSnapshotManifestV1(value.manifest)
    if (pointer && (manifest.generation !== pointer.generation
      || manifest.content_sha256 !== pointer.content_sha256)) return null
    const snapshot = await parsePublicSnapshotV1(value.snapshot)
    return matchesManifest(snapshot, manifest) ? { manifest, snapshot } : null
  } catch {
    return null
  }
}

async function readCachedPair(
  cache: ReadSnapshotCache,
  request: Request,
  pointer?: CachePointer,
): Promise<VerifiedPair | null> {
  try {
    const response = await cache.match(request)
    return response ? parseCachedPair(await response.json(), pointer) : null
  } catch {
    return null
  }
}

async function readLastVerifiedPair(cache: ReadSnapshotCache): Promise<VerifiedPair | null> {
  try {
    const response = await cache.match(lastVerifiedRequest())
    if (!response) return null
    const pointer = parseCachePointer(await response.json())
    return pointer ? readCachedPair(cache, cacheRequest(pointer), pointer) : null
  } catch {
    return null
  }
}

function rollsBackOrConflicts(candidate: PublicSnapshotManifestV1, verified: PublicSnapshotManifestV1): boolean {
  return candidate.generation < verified.generation
    || (candidate.generation === verified.generation
      && candidate.content_sha256 !== verified.content_sha256)
}

async function loadR2Pair(
  dataR2: ReadSnapshotDataR2,
  manifest: PublicSnapshotManifestV1,
): Promise<VerifiedPair | null> {
  try {
    const object = await dataR2.get(manifest.snapshot_key)
    if (object === null || object.key !== manifest.snapshot_key) return null
    const snapshot = await parsePublicSnapshotV1(JSON.parse(await object.text()))
    return matchesManifest(snapshot, manifest) ? { manifest, snapshot } : null
  } catch {
    return null
  }
}

let cacheWriteQueue: Promise<void> = Promise.resolve()

// ponytail: Cache API entries are local/evictable and this queue is per isolate; strict global fencing needs shared strongly consistent state.
async function rememberVerifiedPair(cache: ReadSnapshotCache, pair: VerifiedPair): Promise<VerifiedPair | null> {
  let newerPair: VerifiedPair | null = null
  const write = cacheWriteQueue.then(async () => {
    const latest = await readLastVerifiedPair(cache)
    if (latest && rollsBackOrConflicts(pair.manifest, latest.manifest)) {
      newerPair = latest
      return
    }
    const pointer: CachePointer = {
      generation: pair.manifest.generation,
      content_sha256: pair.manifest.content_sha256,
    }
    await cache.put(
      cacheRequest(pair.manifest),
      cacheResponse(pair, true),
    )
    await cache.put(
      lastVerifiedRequest(),
      cacheResponse(pointer),
    )
  })
  cacheWriteQueue = write.then(() => {}, () => {})
  try {
    await write
  } catch {
    // Cache warming is best effort; the verified R2 pair is already loaded.
  }
  return newerPair
}

function cacheSource(pair: VerifiedPair): SnapshotSource {
  return { mode: 'cache', ...pair }
}

export async function readSnapshotSource(
  dataR2: ReadSnapshotDataR2,
  cache: ReadSnapshotCache,
): Promise<SnapshotSource> {
  const lastVerified = await readLastVerifiedPair(cache)
  let manifest: PublicSnapshotManifestV1 | null = null
  try {
    const object = await dataR2.get(MANIFEST_KEY)
    if (object !== null && object.key === MANIFEST_KEY) {
      manifest = parsePublicSnapshotManifestV1(JSON.parse(await object.text()))
    }
  } catch {
    // A missing or invalid manifest falls through to the last verified pair.
  }
  if (!manifest) return lastVerified ? cacheSource(lastVerified) : { mode: 'legacy' }
  if (lastVerified && rollsBackOrConflicts(manifest, lastVerified.manifest)) {
    return cacheSource(lastVerified)
  }

  const pair = await loadR2Pair(dataR2, manifest)
  if (pair) {
    const newerPair = await rememberVerifiedPair(cache, pair)
    return newerPair ? cacheSource(newerPair) : { mode: 'r2', ...pair }
  }

  const cachedManifestPair = await readCachedPair(cache, cacheRequest(manifest), manifest)
  if (cachedManifestPair) {
    const newerPair = await rememberVerifiedPair(cache, cachedManifestPair)
    return cacheSource(newerPair ?? cachedManifestPair)
  }
  return lastVerified ? cacheSource(lastVerified) : { mode: 'legacy' }
}
