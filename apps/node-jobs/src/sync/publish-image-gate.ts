import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import { imageOriginalKey, imageThumbV2Key } from '@airing-cal/storage'
import { collectReferencedImageHashes, type PublicStore } from '@airing-cal/v3-core'

export function contentTypeForKey(key: string): string {
  if (key.endsWith('.webp')) return 'image/webp'
  if (key.endsWith('.png')) return 'image/png'
  if (key.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

export interface PublishImageGateResult {
  /** Distinct referenced image hashes checked. */
  hashes: number
  uploaded: number
  /** Present in the public store with nothing local to compare against. */
  reused: number
  /** Present locally and unchanged (size + etag/md5 match) — no download, no upload (C5). */
  skipped_unchanged: number
  /** Present in the public store but differing from the local file (public copy wins; keys are immutable). */
  mismatched: number
  /** Referenced thumb.v2.webp objects absent everywhere (thumbs are optional; originals are not). */
  missing_thumbs: number
}

const MD5_ETAG = /^[0-9a-f]{32}$/

function etagMatches(localBytes: Uint8Array, etag: string | null): boolean {
  if (!etag) return false
  const normalized = etag.trim().replace(/^W\//, '').replaceAll('"', '').toLowerCase()
  if (!MD5_ETAG.test(normalized)) return false
  return normalized === createHash('md5').update(localBytes).digest('hex')
}

interface LocalFile {
  bytes: Uint8Array
  size: number
}

function readLocalFile(imageRoot: string | null, key: string): LocalFile | null {
  const path = imageRoot ? join(imageRoot, ...key.split('/')) : null
  if (!path || !existsSync(path)) return null
  const bytes = new Uint8Array(readFileSync(path))
  return { bytes, size: bytes.byteLength }
}

/**
 * C2 publish gate + C5 bounded mirror: before any pointer commit, every referenced
 * image hash from the Snapshot under publish must be readable in the PublicStore
 * (`original`). Missing objects are uploaded from the local image root when present;
 * otherwise the publish fails closed. `thumb.v2.webp` is materialized only for large
 * covers, so thumbs are mirrored when available locally/publicly and reported (not
 * fatal) when absent.
 *
 * Unchanged objects are skipped by size + etag (HEAD, not a full download) when the
 * store supports `headObject`; keys are content-addressed and immutable, so an
 * object that is already present always wins over re-uploading.
 */
export async function ensurePublishImagesComplete(options: {
  snapshot: PublicSnapshotV1
  publicStore: PublicStore
  imageRoot: string | null
}): Promise<PublishImageGateResult> {
  let uploaded = 0
  let reused = 0
  let skippedUnchanged = 0
  let mismatched = 0
  let missingThumbs = 0
  const hashes = collectReferencedImageHashes(options.snapshot)
  for (const hash of hashes) {
    for (const key of [imageOriginalKey(hash), imageThumbV2Key(hash)]) {
      const local = readLocalFile(options.imageRoot, key)
      const head = options.publicStore.headObject
        ? await options.publicStore.headObject(key)
        : null
      if (head) {
        const unchanged = local != null
          && local.size === head.size
          && (head.etag == null || etagMatches(local.bytes, head.etag))
        if (unchanged) skippedUnchanged += 1
        else if (local != null) mismatched += 1
        else reused += 1
        continue
      }
      const existing = await options.publicStore.getSnapshotBytes(key)
      if (existing) {
        if (local == null) {
          reused += 1
        } else if (local.size === existing.byteLength
          && local.bytes.every((byte, index) => byte === existing[index])) {
          skippedUnchanged += 1
        } else {
          mismatched += 1
        }
        continue
      }
      if (local) {
        await options.publicStore.putImmutableObject(key, local.bytes, contentTypeForKey(key))
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
  return {
    hashes: hashes.size,
    uploaded,
    reused,
    skipped_unchanged: skippedUnchanged,
    mismatched,
    missing_thumbs: missingThumbs,
  }
}
