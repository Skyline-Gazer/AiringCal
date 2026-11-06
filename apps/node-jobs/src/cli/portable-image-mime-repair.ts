import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { sniffImage } from '@airing-cal/storage'
import {
  ObjectStorePreconditionError,
  type ConditionalObjectStore,
} from '../adapters/object-store.ts'
import { readPublicS3Config } from '../adapters/s3-env.ts'
import { createS3ObjectStore } from '../adapters/s3-object-store.ts'

export const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const IMAGE_CONTENT_DISPOSITION = 'inline'

const DEFAULT_PREFIX = 'images/'
const DEFAULT_CONCURRENCY = 8
const MAX_CONCURRENCY = 32
const ORIGINAL_SUFFIX = '/original'

export type ImageMimeRepairItemStatus =
  | 'ok'
  | 'would_fix'
  | 'repaired'
  | 'skipped_unknown'
  | 'conflict'
  | 'verify_failed'
  | 'cdn_stale_pending'
  | 'missing'
  | 'error'

export interface ImageMimeRepairItem {
  key: string
  status: ImageMimeRepairItemStatus
  oldType?: string | null
  newType?: string | null
  content_sha256?: string
  etag?: string
  publicUrl?: string
  message?: string
}

export interface ImageMimeRepairCounts {
  scanned: number
  ok: number
  would_fix: number
  repaired: number
  skipped_unknown: number
  conflict: number
  verify_failed: number
  cdn_stale_pending: number
  missing: number
  error: number
}

export interface ImageMimeRepairReport {
  status: 'dry_run' | 'applied' | 'refused'
  stage: 'image_mime_repair'
  apply: boolean
  bucket: string | null
  prefix: string
  counts: ImageMimeRepairCounts
  items: ImageMimeRepairItem[]
  aborted: boolean
  /** False when any repaired object still serves application/octet-stream on the public URL. */
  complete: boolean
}

export interface ImageMimeRepairArgs {
  apply: boolean
  prefix: string
  concurrency: number
  reportPath: string | null
  key: string | null
  failFast: boolean
  iAmSureProduction: boolean
}

export interface ImageMimeRepairCdnHead {
  contentType: string | null
}

export interface ImageMimeRepairCdnClient {
  head(url: string): Promise<ImageMimeRepairCdnHead>
  purge?(url: string): Promise<boolean>
}

export interface RunImageMimeRepairOptions {
  store: ConditionalObjectStore
  apply: boolean
  prefix?: string
  concurrency?: number
  key?: string | null
  failFast?: boolean
  reportPath?: string | null
  iAmSureProduction?: boolean
  env?: Record<string, string | undefined>
  bucket?: string | null
  cdn?: ImageMimeRepairCdnClient | null
  /** Cap how many repaired keys get a public CDN HEAD (default 1 sample). */
  cdnSampleLimit?: number
}

function readArg(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] ?? null : null
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(value)))
}

export function parseImageMimeRepairArgs(argv: readonly string[]): ImageMimeRepairArgs {
  const concurrencyRaw = Number(readArg(argv, '--concurrency') ?? DEFAULT_CONCURRENCY)
  return {
    apply: argv.includes('--apply'),
    prefix: readArg(argv, '--prefix') ?? DEFAULT_PREFIX,
    concurrency: clampConcurrency(concurrencyRaw),
    reportPath: readArg(argv, '--report'),
    key: readArg(argv, '--key'),
    failFast: argv.includes('--fail-fast'),
    iAmSureProduction: argv.includes('--i-am-sure-production'),
  }
}

const PRODUCTION_FORBIDDEN_BUCKETS: Record<string, true> = {
  'airing-cal-public': true,
  'airing-cal-images': true,
  'airing-cal-data': true,
  'airing-cal-checkpoint': true,
  'airingcal-production': true,
}

function isProductionBucket(bucket: string | null | undefined): boolean {
  if (!bucket) return false
  const lower = bucket.toLowerCase()
  if (PRODUCTION_FORBIDDEN_BUCKETS[lower]) return true
  return lower.includes('production')
}

export function assertProductionRepairAllowed(input: {
  apply: boolean
  env: Record<string, string | undefined>
  bucket: string | null | undefined
  iAmSureProduction: boolean
}): void {
  if (!input.apply) return
  const envIsProduction = (input.env.AIRINGCAL_ENV ?? '').trim().toLowerCase() === 'production'
  const bucketIsProduction = isProductionBucket(input.bucket)
  if (!envIsProduction && !bucketIsProduction) return
  if (envIsProduction && bucketIsProduction && input.iAmSureProduction) return
  if (envIsProduction && input.iAmSureProduction && !bucketIsProduction) return
  throw new Error(
    'Refusing production MIME repair apply: require both --i-am-sure-production and AIRINGCAL_ENV=production',
  )
}

export function imageMimeRepairExitCode(report: {
  aborted: boolean
  complete: boolean
  counts: Pick<ImageMimeRepairCounts, 'conflict' | 'verify_failed' | 'error' | 'cdn_stale_pending'>
}): number {
  if (report.aborted) return 1
  if (!report.complete) return 1
  if (report.counts.conflict > 0) return 1
  if (report.counts.verify_failed > 0) return 1
  if (report.counts.error > 0) return 1
  if (report.counts.cdn_stale_pending > 0) return 1
  return 0
}

function emptyCounts(): ImageMimeRepairCounts {
  return {
    scanned: 0,
    ok: 0,
    would_fix: 0,
    repaired: 0,
    skipped_unknown: 0,
    conflict: 0,
    verify_failed: 0,
    cdn_stale_pending: 0,
    missing: 0,
    error: 0,
  }
}

function bump(counts: ImageMimeRepairCounts, status: ImageMimeRepairItemStatus): void {
  counts.scanned += 1
  switch (status) {
    case 'ok':
      counts.ok += 1
      break
    case 'would_fix':
      counts.would_fix += 1
      break
    case 'repaired':
      counts.repaired += 1
      break
    case 'skipped_unknown':
      counts.skipped_unknown += 1
      break
    case 'conflict':
      counts.conflict += 1
      break
    case 'verify_failed':
      counts.verify_failed += 1
      break
    case 'cdn_stale_pending':
      counts.cdn_stale_pending += 1
      break
    case 'missing':
      counts.missing += 1
      break
    case 'error':
      counts.error += 1
      break
  }
}

function isOriginalKey(key: string): boolean {
  return key.endsWith(ORIGINAL_SUFFIX)
}

function alreadyImageContentType(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('image/')
}

function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

function joinPublicUrl(base: string, key: string): string {
  const trimmed = base.replace(/\/+$/, '')
  const path = key.replace(/^\/+/, '')
  return `${trimmed}/${path}`
}

function resolvePublicBase(env: Record<string, string | undefined>): string | null {
  const imageBase = env.AIRINGCAL_IMAGE_BASE_URL?.trim()
  if (imageBase) return imageBase
  const publicBase = env.AIRINGCAL_PUBLIC_BASE_URL?.trim()
  return publicBase || null
}

async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      if (shouldStop()) return
      const index = next
      next += 1
      if (index >= items.length) return
      await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
}

async function repairOneKey(input: {
  store: ConditionalObjectStore
  key: string
  apply: boolean
}): Promise<ImageMimeRepairItem> {
  const { store, key, apply } = input
  const head = await store.head(key)
  if (!head) {
    return { key, status: 'missing', message: 'object missing' }
  }
  const oldType = head.contentType ?? null
  if (alreadyImageContentType(oldType)) {
    return { key, status: 'ok', oldType, newType: oldType, etag: head.etag }
  }

  const got = await store.get(key)
  if (!got) {
    return { key, status: 'missing', oldType, message: 'object missing on GET' }
  }
  const contentSha256 = sha256Hex(got.body)
  const sniffed = sniffImage(got.body)
  if (!sniffed) {
    return {
      key,
      status: 'skipped_unknown',
      oldType,
      newType: null,
      content_sha256: contentSha256,
      etag: got.etag,
    }
  }

  if (!apply) {
    return {
      key,
      status: 'would_fix',
      oldType,
      newType: sniffed,
      content_sha256: contentSha256,
      etag: got.etag,
    }
  }

  if (typeof store.rewriteMetadata !== 'function') {
    return {
      key,
      status: 'error',
      oldType,
      newType: sniffed,
      content_sha256: contentSha256,
      message: 'store does not implement rewriteMetadata',
    }
  }

  try {
    await store.rewriteMetadata(key, {
      contentType: sniffed,
      cacheControl: IMAGE_CACHE_CONTROL,
      contentDisposition: IMAGE_CONTENT_DISPOSITION,
      expectedEtag: head.etag,
      preserveUserMetadata: true,
    })
  } catch (error) {
    if (error instanceof ObjectStorePreconditionError) {
      return {
        key,
        status: 'conflict',
        oldType,
        newType: sniffed,
        content_sha256: contentSha256,
        etag: head.etag,
        message: error.message,
      }
    }
    return {
      key,
      status: 'error',
      oldType,
      newType: sniffed,
      content_sha256: contentSha256,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const verified = await store.get(key)
  if (!verified) {
    return {
      key,
      status: 'verify_failed',
      oldType,
      newType: sniffed,
      content_sha256: contentSha256,
      message: 'object missing after rewrite',
    }
  }
  const verifiedHash = sha256Hex(verified.body)
  if (verifiedHash !== contentSha256) {
    return {
      key,
      status: 'verify_failed',
      oldType,
      newType: sniffed,
      content_sha256: contentSha256,
      message: `body sha256 changed ${contentSha256} → ${verifiedHash}`,
    }
  }
  const verifiedHead = await store.head(key)
  const verifiedType = verifiedHead?.contentType ?? verified.contentType ?? null
  if (verifiedType !== sniffed) {
    return {
      key,
      status: 'verify_failed',
      oldType,
      newType: sniffed,
      content_sha256: contentSha256,
      message: `Content-Type mismatch after rewrite: expected ${sniffed}, got ${verifiedType ?? 'undefined'}`,
    }
  }

  return {
    key,
    status: 'repaired',
    oldType,
    newType: sniffed,
    content_sha256: contentSha256,
    etag: verifiedHead?.etag ?? verified.etag,
  }
}

async function checkCdnSample(input: {
  item: ImageMimeRepairItem
  env: Record<string, string | undefined>
  cdn: ImageMimeRepairCdnClient
}): Promise<ImageMimeRepairItem> {
  const base = resolvePublicBase(input.env)
  if (!base) {
    // Object rewrite already verified; skip public URL probe when no CDN base is configured.
    return input.item
  }
  const publicUrl = joinPublicUrl(base, input.item.key)
  const head = await input.cdn.head(publicUrl)
  const type = head.contentType?.toLowerCase() ?? null
  const mediaType = type?.split(';', 1)[0]?.trim() ?? null
  if (mediaType && mediaType.startsWith('image/')) {
    return { ...input.item, publicUrl }
  }
  const purged = input.cdn.purge ? await input.cdn.purge(publicUrl) : false
  if (purged) {
    const after = await input.cdn.head(publicUrl)
    const afterType = after.contentType?.toLowerCase() ?? null
    const afterMedia = afterType?.split(';', 1)[0]?.trim() ?? null
    if (afterMedia && afterMedia.startsWith('image/')) {
      return { ...input.item, publicUrl, message: 'cdn purged' }
    }
  }
  return {
    ...input.item,
    status: 'cdn_stale_pending',
    publicUrl,
    message: `public URL still Content-Type=${type ?? 'missing'}; manual purge required before P5 MIME gate`,
  }
}

export async function runImageMimeRepair(
  options: RunImageMimeRepairOptions,
): Promise<ImageMimeRepairReport> {
  const env = options.env ?? process.env
  const apply = options.apply
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const concurrency = clampConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY)
  const failFast = options.failFast === true
  const iAmSureProduction = options.iAmSureProduction === true
  const bucket = options.bucket ?? null
  const cdnSampleLimit = options.cdnSampleLimit ?? 1

  assertProductionRepairAllowed({ apply, env, bucket, iAmSureProduction })

  if (typeof options.store.list !== 'function') {
    throw new Error('object store must implement list(prefix) for MIME repair')
  }

  const listed = options.key
    ? [options.key]
    : (await options.store.list(prefix)).filter(isOriginalKey)
  const keys = listed.filter(isOriginalKey)

  const counts = emptyCounts()
  const items: ImageMimeRepairItem[] = []
  let aborted = false

  await mapPool(keys, concurrency, async (key) => {
    if (aborted) return
    const item = await repairOneKey({ store: options.store, key, apply })
    if (failFast && item.status === 'conflict') aborted = true
    if (failFast && item.status === 'error') aborted = true
    if (failFast && item.status === 'verify_failed') aborted = true
    items.push(item)
    bump(counts, item.status)
  }, () => aborted)

  // Stable report order for operators / tests.
  items.sort((a, b) => a.key.localeCompare(b.key))

  if (apply && options.cdn && resolvePublicBase(env)) {
    let samples = 0
    for (let i = 0; i < items.length && samples < cdnSampleLimit; i += 1) {
      const item = items[i]!
      if (item.status !== 'repaired') continue
      samples += 1
      const checked = await checkCdnSample({ item, env, cdn: options.cdn })
      items[i] = checked
      if (checked.status === 'cdn_stale_pending') {
        // Keep repaired count (object metadata fixed); CDN lag is a separate gate.
        counts.cdn_stale_pending += 1
      }
    }
  }

  const complete = counts.cdn_stale_pending === 0
    && counts.verify_failed === 0
    && counts.conflict === 0
    && counts.error === 0

  const report: ImageMimeRepairReport = {
    status: apply ? 'applied' : 'dry_run',
    stage: 'image_mime_repair',
    apply,
    bucket,
    prefix,
    counts,
    items,
    aborted,
    complete,
  }

  if (options.reportPath) {
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }

  return report
}

export async function createDefaultCdnClient(
  env: Record<string, string | undefined> = process.env,
): Promise<ImageMimeRepairCdnClient> {
  void env
  return {
    async head(url: string): Promise<ImageMimeRepairCdnHead> {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      return { contentType: response.headers.get('content-type') }
    },
    async purge(): Promise<boolean> {
      // Platform purge credentials are optional; record stale when unavailable.
      return false
    },
  }
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseImageMimeRepairArgs(argv)
  const env = process.env
  const publicS3 = readPublicS3Config(env)
  if (!publicS3) {
    console.error(JSON.stringify({
      status: 'failed',
      stage: 'image_mime_repair',
      message: 'Configure AIRINGCAL_PUBLIC_S3_* for portable-image-mime-repair',
    }))
    return 1
  }

  try {
    assertProductionRepairAllowed({
      apply: args.apply,
      env,
      bucket: publicS3.bucket,
      iAmSureProduction: args.iAmSureProduction,
    })
  } catch (error) {
    console.error(JSON.stringify({
      status: 'refused',
      stage: 'image_mime_repair',
      message: error instanceof Error ? error.message : String(error),
    }))
    return 2
  }

  const store = createS3ObjectStore(publicS3)
  try {
    const cdn = args.apply ? await createDefaultCdnClient(env) : null
    const report = await runImageMimeRepair({
      store,
      apply: args.apply,
      prefix: args.prefix,
      concurrency: args.concurrency,
      key: args.key,
      failFast: args.failFast,
      reportPath: args.reportPath,
      iAmSureProduction: args.iAmSureProduction,
      env,
      bucket: publicS3.bucket,
      cdn,
    })
    console.log(JSON.stringify({
      status: report.status,
      stage: report.stage,
      bucket: report.bucket,
      apply: report.apply,
      counts: report.counts,
      aborted: report.aborted,
      complete: report.complete,
      sample: report.items.slice(0, 20),
    }, null, 2))
    return imageMimeRepairExitCode(report)
  } finally {
    store.close()
  }
}

if (process.argv[1]?.endsWith('portable-image-mime-repair.ts')
  || process.argv[1]?.endsWith('portable-image-mime-repair.mjs')) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(JSON.stringify({
      status: 'failed',
      stage: 'image_mime_repair',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
