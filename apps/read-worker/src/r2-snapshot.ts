import { parsePublicSnapshotV1 } from '@airing-cal/domain'
import {
  PUBLIC_READ_MODE_KV_KEY,
  type PublicSnapshotPointerV1,
  type PublicSnapshotV1,
} from '@airing-cal/storage'

const POINTER_KEY = 'public:current'
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/

export interface ReadSnapshotKv {
  get(key: string, type: 'json'): Promise<unknown>
}

export interface ReadSnapshotDataR2 {
  get(key: string): Promise<{ key: string; text(): Promise<string> } | null>
}

export interface ReadSnapshotCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export type SnapshotSource =
  | { mode: 'legacy' }
  | { mode: 'r2'; snapshot: PublicSnapshotV1 }

function cacheRequest(contentHash: string): Request {
  return new Request(`https://cache.local/r2-snapshot/${contentHash}`)
}

export function validatePointer(value: unknown): PublicSnapshotPointerV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const required = ['schema_version', 'generation', 'content_hash', 'r2_key', 'published_at']
  if (candidate.schema_version !== 1
    || !required.every((key) => Object.hasOwn(candidate, key))
    || Object.keys(candidate).some((key) => !required.includes(key))
    || !Number.isSafeInteger(candidate.generation)
    || (candidate.generation as number) < 0
    || typeof candidate.content_hash !== 'string'
    || !LOWERCASE_SHA256.test(candidate.content_hash)
    || typeof candidate.r2_key !== 'string'
    || !Number.isSafeInteger(candidate.published_at)
    || (candidate.published_at as number) < 0) {
    return null
  }
  const pointer = candidate as unknown as PublicSnapshotPointerV1
  if (pointer.r2_key !== `snapshots/v1/${pointer.generation}-${pointer.content_hash}.json`) {
    return null
  }
  return pointer
}

function matchesPointer(snapshot: PublicSnapshotV1, pointer: PublicSnapshotPointerV1): boolean {
  return snapshot.schema_version === 1
    && snapshot.generation === pointer.generation
    && snapshot.content_hash === pointer.content_hash
}

export async function loadVerifiedSnapshot(
  dataR2: ReadSnapshotDataR2,
  cache: ReadSnapshotCache,
  pointer: PublicSnapshotPointerV1,
): Promise<{ snapshot: PublicSnapshotV1; fromCache: boolean } | null> {
  let snapshot: PublicSnapshotV1 | null = null
  try {
    const object = await dataR2.get(pointer.r2_key)
    if (object !== null) {
      const candidate = await parsePublicSnapshotV1(JSON.parse(await object.text()))
      if (matchesPointer(candidate, pointer)) snapshot = candidate
    }
  } catch {
    snapshot = null
  }
  if (snapshot !== null) {
    try {
      await cache.put(
        cacheRequest(pointer.content_hash),
        new Response(JSON.stringify(snapshot), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    } catch {
      // Cache warming is best effort; the verified R2 object is already loaded.
    }
    return { snapshot, fromCache: false }
  }
  try {
    const cached = await cache.match(cacheRequest(pointer.content_hash))
    if (cached) {
      const candidate = await parsePublicSnapshotV1(await cached.json())
      if (matchesPointer(candidate, pointer)) return { snapshot: candidate, fromCache: true }
    }
  } catch {
    // Fall through to legacy below.
  }
  return null
}

export async function readSnapshotSource(
  kv: ReadSnapshotKv,
  dataR2: ReadSnapshotDataR2,
  cache: ReadSnapshotCache,
): Promise<SnapshotSource> {
  const readMode = await kv.get(PUBLIC_READ_MODE_KV_KEY, 'json')
  const isR2 = typeof readMode === 'object'
    && readMode !== null
    && !Array.isArray(readMode)
    && (readMode as { mode?: unknown }).mode === 'r2'
  if (isR2) {
    const pointer = validatePointer(await kv.get(POINTER_KEY, 'json'))
    if (pointer) {
      const loaded = await loadVerifiedSnapshot(dataR2, cache, pointer)
      if (loaded) return { mode: 'r2', snapshot: loaded.snapshot }
    }
  }
  return { mode: 'legacy' }
}
