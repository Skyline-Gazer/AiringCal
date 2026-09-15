import {
  parsePublicSnapshotManifestV1,
  parsePublicSnapshotV1,
  type PublicSnapshotManifestV1,
} from '@airing-cal/domain'
import type { PublicSnapshotV1 } from '@airing-cal/storage'

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
  | { mode: 'r2'; manifest: PublicSnapshotManifestV1; snapshot: PublicSnapshotV1 }

function cacheRequest(contentHash: string): Request {
  return new Request('https://cache.local/r2-snapshot/' + contentHash)
}

function matchesManifest(snapshot: PublicSnapshotV1, manifest: PublicSnapshotManifestV1): boolean {
  const publishedAt = new Date(snapshot.published_at * 1_000)
  return snapshot.generation === manifest.generation
    && snapshot.content_hash === manifest.content_sha256
    && snapshot.summary._total === manifest.item_count
    && Number.isFinite(publishedAt.getTime())
    && publishedAt.toISOString() === manifest.published_at
}

export async function loadVerifiedSnapshot(
  dataR2: ReadSnapshotDataR2,
  cache: ReadSnapshotCache,
  manifest: PublicSnapshotManifestV1,
): Promise<{ snapshot: PublicSnapshotV1; fromCache: boolean } | null> {
  let snapshot: PublicSnapshotV1 | null = null
  try {
    const object = await dataR2.get(manifest.snapshot_key)
    if (object !== null && object.key === manifest.snapshot_key) {
      const candidate = await parsePublicSnapshotV1(JSON.parse(await object.text()))
      if (matchesManifest(candidate, manifest)) snapshot = candidate
    }
  } catch {
    snapshot = null
  }
  if (snapshot !== null) {
    try {
      await cache.put(
        cacheRequest(manifest.content_sha256),
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
    const cached = await cache.match(cacheRequest(manifest.content_sha256))
    if (cached) {
      const candidate = await parsePublicSnapshotV1(await cached.json())
      if (matchesManifest(candidate, manifest)) return { snapshot: candidate, fromCache: true }
    }
  } catch {
    // A cached payload is usable only when it matches the current valid manifest.
  }
  return null
}

export async function readSnapshotSource(
  dataR2: ReadSnapshotDataR2,
  cache: ReadSnapshotCache,
): Promise<SnapshotSource> {
  try {
    const manifestObject = await dataR2.get(MANIFEST_KEY)
    if (manifestObject === null || manifestObject.key !== MANIFEST_KEY) return { mode: 'legacy' }
    const manifest = parsePublicSnapshotManifestV1(JSON.parse(await manifestObject.text()))
    const loaded = await loadVerifiedSnapshot(dataR2, cache, manifest)
    if (loaded) return { mode: 'r2', manifest, snapshot: loaded.snapshot }
  } catch {
    // Missing or invalid R2 data uses the complete legacy KV snapshot path.
  }
  return { mode: 'legacy' }
}
