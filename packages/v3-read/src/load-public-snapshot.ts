import { parsePublicSnapshotV1 } from '@airing-cal/domain'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import type { PublicStore } from '@airing-cal/v3-core'

export async function loadVerifiedPublicSnapshot(publicStore: PublicStore): Promise<{
  snapshot: PublicSnapshotV1
  generation: number
  content_hash: string
  artifact_ref: string
} | null> {
  const pointer = await publicStore.getCurrentRelease()
  if (!pointer) return null
  const bytes = await publicStore.getSnapshotBytes(pointer.artifact_ref)
  if (!bytes) return null
  const snapshot = await parsePublicSnapshotV1(JSON.parse(new TextDecoder().decode(bytes)))
  if (snapshot.generation !== pointer.generation || snapshot.content_hash !== pointer.content_hash) {
    return null
  }
  return {
    snapshot,
    generation: pointer.generation,
    content_hash: pointer.content_hash,
    artifact_ref: pointer.artifact_ref,
  }
}
