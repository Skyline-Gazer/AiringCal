import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import { imageOriginalKey, imageThumbV2Key, sniffImage } from '@airing-cal/storage'
import { collectReferencedImageHashes, type PublicStore } from '@airing-cal/v3-core'
import { emitProgress, emitStage } from './sync-progress.ts'

/** Parallel object operations; keeps a 676-hash first publish inside the job timeout. */
const DEFAULT_CONCURRENCY = 8
const MAX_CONCURRENCY = 32
const PROGRESS_EVERY = 25

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(value)))
}

export class UnrecognizedImageContentTypeError extends Error {
  constructor(readonly key: string) {
    super(`Unrecognized image bytes for ${key}; refusing application/octet-stream`)
    this.name = 'UnrecognizedImageContentTypeError'
  }
}

export function contentTypeForKey(key: string, bytes?: Uint8Array): string {
  if (key.endsWith('.webp')) return 'image/webp'
  if (key.endsWith('.png')) return 'image/png'
  if (key.endsWith('.json')) return 'application/json'
  // Extensionless originals (images/<hash>/original): sniff or fail closed.
  if (/(?:^|\/)images\/[0-9a-f]{64}\/original$/.test(key)) {
    const sniffed = bytes ? sniffImage(bytes) : null
    if (!sniffed) throw new UnrecognizedImageContentTypeError(key)
    return sniffed
  }
  if (bytes) {
    const sniffed = sniffImage(bytes)
    if (sniffed) return sniffed
  }
  // Non-image objects only (never an original image key).
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
  /** Bounded parallel object work; R2 upload latency dominates a first publish. */
  concurrency?: number
}): Promise<PublishImageGateResult> {
  const hashes = collectReferencedImageHashes(options.snapshot)
  const concurrency = clampConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY)
  // Originals first: a fatal original failure must not leave thumb-only side effects.
  const phases = [
    [...hashes].map((hash) => imageOriginalKey(hash)),
    [...hashes].map((hash) => imageThumbV2Key(hash)),
  ]
  const total = hashes.size * 2
  let uploaded = 0
  let reused = 0
  let skippedUnchanged = 0
  let missingThumbs = 0
  let done = 0
  let failure: unknown = null

  emitStage('Publish image gate started', {
    stage: 'publish_images',
    referenced_hashes: hashes.size,
    objects: total,
    concurrency,
  })

  for (const keys of phases) {
    if (failure !== null) break
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (failure === null) {
        const key = keys[nextIndex]
        nextIndex += 1
        if (!key) return
        const outcome = await processObject(key, options, hashes)
        if (outcome === 'uploaded') uploaded += 1
        else if (outcome === 'reused') reused += 1
        else if (outcome === 'skipped_unchanged') skippedUnchanged += 1
        else missingThumbs += 1
        done += 1
        if (done % PROGRESS_EVERY === 0 || done === total) {
          emitProgress('publish', 'publish_images_progress', done, total, {
            uploaded,
            reused,
            skipped_unchanged: skippedUnchanged,
            missing_thumbs: missingThumbs,
          })
        }
      }
    }
    const runners = Array.from({ length: Math.min(concurrency, keys.length) }, () =>
      worker().catch((error: unknown) => {
        if (failure === null) failure = error
      }))
    await Promise.all(runners)
  }
  if (failure !== null) throw failure

  return {
    hashes: hashes.size,
    uploaded,
    reused,
    skipped_unchanged: skippedUnchanged,
    missing_thumbs: missingThumbs,
  }
}

type ObjectOutcome = 'uploaded' | 'reused' | 'skipped_unchanged' | 'missing_thumb'

/** One referenced object: verify existing content or upload from the local image root (immutable). */
async function processObject(
  key: string,
  options: { publicStore: PublicStore; imageRoot: string | null },
  hashes: ReadonlySet<string>,
): Promise<ObjectOutcome> {
  const hash = key.split('/')[1] ?? ''
  if (!hashes.has(hash)) {
    throw new Error(`Publish gate received an object key outside the snapshot: ${key}`)
  }
  const local = readLocalFile(options.imageRoot, key)
  const head = options.publicStore.headObject
    ? await options.publicStore.headObject(key)
    : null
  if (head) {
    if (local == null) return 'reused'
    const verdict = await compareWithPublicObject(options.publicStore, key, local, head)
    if (verdict === 'identical') return 'skipped_unchanged'
    throw new Error(
      verdict === 'unreadable'
        ? `Publish gate failed: ${key} is reported present but its bytes cannot be read`
        : `Publish gate failed: ${key} differs from the local file; immutable public image objects must never be replaced`,
    )
  }
  const existing = await options.publicStore.getSnapshotBytes(key)
  if (existing) {
    if (local == null) return 'reused'
    if (existing.byteLength === local.bytes.byteLength
      && existing.every((byte, index) => byte === local.bytes[index])) return 'skipped_unchanged'
    throw new Error(
      `Publish gate failed: ${key} differs from the local file; immutable public image objects must never be replaced`,
    )
  }
  if (local) {
    await options.publicStore.putImmutableObject(key, local.bytes, contentTypeForKey(key, local.bytes))
    return 'uploaded'
  }
  if (key === imageThumbV2Key(hash)) return 'missing_thumb'
  throw new Error(
    `Publish gate failed: referenced image object ${key} is missing from the public store and no local source exists`,
  )
}

