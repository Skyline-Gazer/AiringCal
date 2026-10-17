import { parsePublicSnapshotManifestV1, parsePublicSnapshotV1 } from '@airing-cal/domain'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import type { PublicStore } from '@airing-cal/v3-core/ports'

export interface VerifiedPublicSnapshot {
  snapshot: PublicSnapshotV1
  generation: number
  content_hash: string
  artifact_ref: string
}

export async function loadVerifiedPublicSnapshot(
  publicStore: PublicStore,
): Promise<VerifiedPublicSnapshot | null> {
  const pointer = await publicStore.getCurrentRelease()
  if (!pointer) return null
  const bytes = await publicStore.getSnapshotBytes(pointer.artifact_ref)
  if (!bytes) return null
  const snapshot = await parsePublicSnapshotV1(JSON.parse(new TextDecoder().decode(bytes)))
  if (snapshot.generation !== pointer.generation || snapshot.content_hash !== pointer.content_hash) {
    return null
  }
  const manifestBytes = await publicStore.getSnapshotBytes('public/manifest.json')
  if (manifestBytes) {
    try {
      const manifest = parsePublicSnapshotManifestV1(JSON.parse(new TextDecoder().decode(manifestBytes)))
      if (
        manifest.generation !== pointer.generation
        || manifest.content_sha256 !== pointer.content_hash
        || manifest.snapshot_key !== pointer.artifact_ref
        || manifest.content_sha256 !== snapshot.content_hash
      ) {
        return null
      }
    } catch {
      return null
    }
  }
  return {
    snapshot,
    generation: pointer.generation,
    content_hash: pointer.content_hash,
    artifact_ref: pointer.artifact_ref,
  }
}
