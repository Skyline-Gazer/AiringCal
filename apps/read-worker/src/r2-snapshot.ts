import {
  parsePublicSnapshotManifestV1,
  parsePublicSnapshotV1,
  type PublicSnapshotManifestV1,
} from '@airing-cal/domain'
import { PUBLIC_READ_MODE_KV_KEY, type PublicSnapshotPointerV1, type PublicSnapshotV1 } from '@airing-cal/storage'

const MANIFEST_KEY = 'public/manifest.json'
const POINTER_KEY = 'public:current'
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/

export interface ReadSnapshotDataR2 {
  get(key: string): Promise<{ key: string; text(): Promise<string> } | null>
}

export interface ReadSnapshotKv {
  get(key: string, type: 'json'): Promise<unknown>
}

export interface ReadSnapshotCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export type SnapshotSource =
  | { mode: 'legacy' }
  | { mode: 'r2'; snapshot: PublicSnapshotV1 }

/** Kept for migration health's legacy pointer reporting; public reads use manifests. */
export function validatePointer(value: unknown): PublicSnapshotPointerV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const keys = ['schema_version', 'generation', 'content_hash', 'r2_key', 'published_at']
  if (candidate.schema_version !== 1
    || Object.keys(candidate).length !== keys.length
    || !keys.every((key) => Object.hasOwn(candidate, key))
    || !Number.isSafeInteger(candidate.generation) || (candidate.generation as number) < 0
    || typeof candidate.content_hash !== 'string' || !LOWERCASE_SHA256.test(candidate.content_hash)
    || typeof candidate.r2_key !== 'string'
    || !Number.isSafeInteger(candidate.published_at) || (candidate.published_at as number) < 0) return null
  const pointer = candidate as unknown as PublicSnapshotPointerV1
  return pointer.r2_key === `snapshots/v1/${pointer.generation}-${pointer.content_hash}.json` ? pointer : null
}

function matchesManifest(snapshot: PublicSnapshotV1, manifest: PublicSnapshotManifestV1): boolean {
  return snapshot.generation === manifest.generation
    && snapshot.content_hash === manifest.content_sha256
    && snapshot.summary._total === manifest.item_count
    && new Date(snapshot.published_at * 1000).toISOString() === manifest.published_at
}

function cacheRequest(contentHash: string): Request {
  return new Request(`https://cache.local/r2-snapshot/${contentHash}`)
}

async function loadLegacyVerifiedSnapshot(
  dataR2: ReadSnapshotDataR2,
  cache: ReadSnapshotCache,
  pointer: PublicSnapshotPointerV1,
): Promise<PublicSnapshotV1 | null> {
  try {
    const object = await dataR2.get(pointer.r2_key)
    if (object !== null) {
      const snapshot = await parsePublicSnapshotV1(JSON.parse(await object.text()))
      if (snapshot.generation === pointer.generation && snapshot.content_hash === pointer.content_hash) return snapshot
    }
  } catch {
    // Use the last verified cache entry below.
  }
  try {
    const cached = await cache.match(cacheRequest(pointer.content_hash))
    if (cached) {
      const snapshot = await parsePublicSnapshotV1(await cached.json())
      if (snapshot.generation === pointer.generation && snapshot.content_hash === pointer.content_hash) return snapshot
    }
  } catch {
    // Fall through to legacy below.
  }
  return null
}

export async function loadVerifiedSnapshot(
  dataR2: ReadSnapshotDataR2,
  manifest: PublicSnapshotManifestV1,
): Promise<PublicSnapshotV1 | null> {
  try {
    const object = await dataR2.get(manifest.snapshot_key)
    if (object === null || object.key !== manifest.snapshot_key) return null
    const snapshot = await parsePublicSnapshotV1(JSON.parse(await object.text()))
    return matchesManifest(snapshot, manifest) ? snapshot : null
  } catch {
    return null
  }
}

export async function readSnapshotSource(
  dataR2: ReadSnapshotDataR2,
  legacyKv?: ReadSnapshotKv,
  legacyCache?: ReadSnapshotCache,
): Promise<SnapshotSource> {
  try {
    const object = await dataR2.get(MANIFEST_KEY)
    if (object !== null && object.key === MANIFEST_KEY) {
      const manifest = parsePublicSnapshotManifestV1(JSON.parse(await object.text()))
      const snapshot = await loadVerifiedSnapshot(dataR2, manifest)
      if (snapshot) return { mode: 'r2', snapshot }
    }
  } catch {
    // Preserve the pre-manifest cache fallback for the migration window.
  }
  if (!legacyKv || !legacyCache) return { mode: 'legacy' }
  const readMode = await legacyKv.get(PUBLIC_READ_MODE_KV_KEY, 'json')
  const isR2 = typeof readMode === 'object'
    && readMode !== null
    && !Array.isArray(readMode)
    && (readMode as { mode?: unknown }).mode === 'r2'
  if (!isR2) return { mode: 'legacy' }
  const pointer = validatePointer(await legacyKv.get(POINTER_KEY, 'json'))
  const snapshot = pointer && await loadLegacyVerifiedSnapshot(dataR2, legacyCache, pointer)
  return snapshot ? { mode: 'r2', snapshot } : { mode: 'legacy' }
}
