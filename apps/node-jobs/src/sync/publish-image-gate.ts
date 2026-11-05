import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import { imageOriginalKey, imageThumbV2Key } from '@airing-cal/storage'
import { collectReferencedImageHashes, type PublicStore } from '@airing-cal/v3-core'
import { contentTypeForKey } from './mirror-images.ts'

export interface PublishImageGateResult {
  /** Distinct referenced image hashes checked. */
  hashes: number
  uploaded: number
  reused: number
  /** Referenced thumb.v2.webp objects absent everywhere (thumbs are optional; originals are not). */
  missing_thumbs: number
}

/**
 * C2 publish gate: before any pointer commit, every referenced image hash from the
 * Snapshot under publish must be readable in the PublicStore (`original`). Missing
 * objects are uploaded from the local image root when present; otherwise the publish
 * fails closed. `thumb.v2.webp` is materialized only for large covers, so thumbs are
 * mirrored when available locally/publicly and reported (not fatal) when absent.
 */
export async function ensurePublishImagesComplete(options: {
  snapshot: PublicSnapshotV1
  publicStore: PublicStore
  imageRoot: string | null
}): Promise<PublishImageGateResult> {
  let uploaded = 0
  let reused = 0
  let missingThumbs = 0
  const hashes = collectReferencedImageHashes(options.snapshot)
  for (const hash of hashes) {
    for (const key of [imageOriginalKey(hash), imageThumbV2Key(hash)]) {
      if (await options.publicStore.getSnapshotBytes(key)) {
        reused += 1
        continue
      }
      const localPath = options.imageRoot ? join(options.imageRoot, ...key.split('/')) : null
      if (localPath && existsSync(localPath)) {
        await options.publicStore.putImmutableObject(
          key,
          new Uint8Array(readFileSync(localPath)),
          contentTypeForKey(key),
        )
        uploaded += 1
        continue
      }
      if (key === imageThumbV2Key(hash)) {
        missingThumbs += 1
        continue
      }
      throw new Error(
        `Publish gate failed: referenced image object ${key} is missing from the public store and no local source exists`,
      )
    }
  }
  return { hashes: hashes.size, uploaded, reused, missing_thumbs: missingThumbs }
}
