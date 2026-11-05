import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
  /** Present locally and byte-identical to the published object — no upload (C5). */
  skipped_unchanged: number
  /** Referenced thumb.v2.webp objects absent everywhere (thumbs are optional; originals are not). */
  missing_thumbs: number
}

const MD5_ETAG = /^[0-9a-f]{32}$/

/**
 * Comparable md5 digest of an object-store ETag, or null when the ETag cannot
 * prove content (multipart uploads, filesystem/memory stores that expose none).
 */
function etagDigest(etag: string | null): string | null {
  if (!etag) return null
  const normalized = etag.trim().replace(/^W\//, '').replaceAll('"', '').toLowerCase()
  return MD5_ETAG.test(normalized) ? normalized : null
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
 * Decides whether the published object and the local file are the same content.
 *
 * A comparable md5 ETag is conclusive (and cheap); everything else falls back to
 * a byte comparison, because equal size alone cannot prove equal content for a
 * content-addressed immutable key.
 */
async function compareWithPublicObject(
  publicStore: PublicStore,
  key: string,
  local: LocalFile,
  head: { size: number; etag: string | null },
): Promise<'identical' | 'different' | 'unreadable'> {
  const digest = etagDigest(head.etag)
  if (digest != null) {
    const sameEtag = digest === createHash('md5').update(local.bytes).digest('hex')
    return sameEtag && local.size === head.size ? 'identical' : 'different'
  }
  const existing = await publicStore.getSnapshotBytes(key)
  if (!existing) return 'unreadable'
  if (existing.byteLength !== local.bytes.byteLength) return 'different'
  return existing.every((byte, index) => byte === local.bytes[index]) ? 'identical' : 'different'
}

/**
 * C2 publish gate + C5 bounded mirror: before any pointer commit, every referenced
 * image hash from the Snapshot under publish must be readable in the PublicStore
 * (`original`). Missing objects are uploaded from the local image root when present;
 * otherwise the publish fails closed. `thumb.v2.webp` is materialized only for large
 * covers, so thumbs are mirrored when available locally/publicly and reported (not
 * fatal) when absent.
 *
 * An existing immutable object is never replaced: a content difference between the
 * published object and the local file fails the publish closed instead of being
 * counted and skipped, which would otherwise publish a Snapshot referencing bytes
 * nobody can reconcile.
 */
export async function ensurePublishImagesComplete(options: {
  snapshot: PublicSnapshotV1
  publicStore: PublicStore
  imageRoot: string | null
}): Promise<PublishImageGateResult> {
  let uploaded = 0
  let reused = 0
  let skippedUnchanged = 0
  let missingThumbs = 0
  const hashes = collectReferencedImageHashes(options.snapshot)
  for (const hash of hashes) {
    for (const key of [imageOriginalKey(hash), imageThumbV2Key(hash)]) {
      const local = readLocalFile(options.imageRoot, key)
      const head = options.publicStore.headObject
        ? await options.publicStore.headObject(key)
        : null
      if (head) {
        if (local == null) {
          reused += 1
          continue
        }
        const verdict = await compareWithPublicObject(options.publicStore, key, local, head)
        if (verdict === 'identical') {
          skippedUnchanged += 1
          continue
        }
        throw new Error(
          verdict === 'unreadable'
            ? `Publish gate failed: ${key} is reported present but its bytes cannot be read`
            : `Publish gate failed: ${key} differs from the local file; immutable public image objects must never be replaced`,
        )
      }
      const existing = await options.publicStore.getSnapshotBytes(key)
      if (existing) {
        if (local == null) {
          reused += 1
        } else if (existing.byteLength === local.bytes.byteLength
          && existing.every((byte, index) => byte === local.bytes[index])) {
          skippedUnchanged += 1
        } else {
          throw new Error(
            `Publish gate failed: ${key} differs from the local file; immutable public image objects must never be replaced`,
          )
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
    missing_thumbs: missingThumbs,
  }
}
