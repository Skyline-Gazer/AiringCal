import {
  parsePublicSnapshotManifestV1,
  parsePublicSnapshotV1,
  type PublicSnapshotManifestV1,
} from '@airing-cal/domain'
import { type PublicSnapshotV1 } from '@airing-cal/storage'

const MANIFEST_KEY = 'public/manifest.json'

export interface ReadSnapshotDataR2 {
  get(key: string): Promise<{ key: string; text(): Promise<string> } | null>
}

export interface ReadSnapshotCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export type SnapshotSource =
  | { mode: 'legacy' }
  | { mode: 'r2' | 'cache'; snapshot: PublicSnapshotV1 }

interface VerifiedEnvelope {
  manifest: PublicSnapshotManifestV1
  snapshot: PublicSnapshotV1
}

function matchesManifest(snapshot: PublicSnapshotV1, manifest: PublicSnapshotManifestV1): boolean {
  return snapshot.generation === manifest.generation
    && snapshot.content_hash === manifest.content_sha256
    && snapshot.summary._total === manifest.item_count
    && new Date(snapshot.published_at * 1000).toISOString() === manifest.published_at
}

function cacheRequest(manifest: PublicSnapshotManifestV1): Request {
  return new Request(`https://cache.local/r2-snapshot/${manifest.generation}-${manifest.content_sha256}`)
}

function lastVerifiedCacheRequest(): Request {
  return new Request('https://cache.local/r2-snapshot/last-verified')
}

async function parseVerifiedEnvelope(value: unknown): Promise<VerifiedEnvelope | null> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const candidate = value as Record<string, unknown>
    const manifest = parsePublicSnapshotManifestV1(candidate.manifest)
    const snapshot = await parsePublicSnapshotV1(candidate.snapshot)
    return matchesManifest(snapshot, manifest) ? { manifest, snapshot } : null
  } catch {
    return null
  }
}

async function loadCachedEnvelope(cache: ReadSnapshotCache): Promise<VerifiedEnvelope | null> {
  try {
    const cached = await cache.match(lastVerifiedCacheRequest())
    return cached ? await parseVerifiedEnvelope(await cached.json()) : null
  } catch {
    return null
  }
}

async function cacheVerifiedEnvelope(
  cache: ReadSnapshotCache,
  envelope: VerifiedEnvelope,
): Promise<void> {
  const body = JSON.stringify(envelope)
  try {
    await cache.put(
      cacheRequest(envelope.manifest),
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    )
    await cache.put(
      lastVerifiedCacheRequest(),
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    )
  } catch {
    // Cache warming is best effort; the verified R2 pair is already loaded.
  }
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
  cache?: ReadSnapshotCache,
): Promise<SnapshotSource> {
  const cached = cache && await loadCachedEnvelope(cache)
  try {
    const object = await dataR2.get(MANIFEST_KEY)
    if (object !== null && object.key === MANIFEST_KEY) {
      const manifest = parsePublicSnapshotManifestV1(JSON.parse(await object.text()))
      const snapshot = await loadVerifiedSnapshot(dataR2, manifest)
      if (snapshot) {
        if (cached && (manifest.generation < cached.manifest.generation
          || (manifest.generation === cached.manifest.generation
            && manifest.content_sha256 !== cached.manifest.content_sha256))) {
          return { mode: 'cache', snapshot: cached.snapshot }
        }
        if (cache) await cacheVerifiedEnvelope(cache, { manifest, snapshot })
        return { mode: 'r2', snapshot }
      }
    }
  } catch {
    // Use only a fully revalidated cache envelope below.
  }
  return cached ? { mode: 'cache', snapshot: cached.snapshot } : { mode: 'legacy' }
}
