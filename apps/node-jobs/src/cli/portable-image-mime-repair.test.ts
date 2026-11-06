import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ObjectStorePreconditionError,
  normalizeEtag,
  quoteEtag,
  type ConditionalObjectStore,
  type ObjectGet,
  type ObjectHead,
  type ObjectPutOptions,
  type ObjectRewriteMetadata,
} from '../adapters/object-store.ts'
import {
  IMAGE_CACHE_CONTROL,
  IMAGE_CONTENT_DISPOSITION,
  assertProductionRepairAllowed,
  parseImageMimeRepairArgs,
  runImageMimeRepair,
  type ImageMimeRepairCdnClient,
} from './portable-image-mime-repair.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const KEY_A = `images/${HASH_A}/original`
const KEY_B = `images/${HASH_B}/original`
const KEY_C = `images/${HASH_C}/original`
const KEY_THUMB = `images/${HASH_A}/thumb.v2.webp`

function jpegBytes(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
}

function pngBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
}

function unknownBytes(): Uint8Array {
  return Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04])
}

function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

interface Entry {
  body: Uint8Array
  etag: string
  contentType?: string
  cacheControl?: string
  contentDisposition?: string
  metadata?: Record<string, string>
  forceConflict?: boolean
}

/** In-memory ConditionalObjectStore double with rewriteMetadata + optional conflict injection. */
class RepairStoreDouble implements ConditionalObjectStore {
  readonly objects = new Map<string, Entry>()
  rewriteCalls: Array<{ key: string; meta: ObjectRewriteMetadata }> = []

  async get(key: string): Promise<ObjectGet | null> {
    const entry = this.objects.get(key)
    if (!entry) return null
    return {
      body: new Uint8Array(entry.body),
      etag: entry.etag,
      contentType: entry.contentType,
      size: entry.body.byteLength,
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const entry = this.objects.get(key)
    if (!entry) return null
    return {
      etag: entry.etag,
      contentType: entry.contentType,
      size: entry.body.byteLength,
    }
  }

  async put(key: string, body: Uint8Array, options: ObjectPutOptions = {}): Promise<ObjectHead> {
    const copy = new Uint8Array(body)
    const entry: Entry = {
      body: copy,
      etag: quoteEtag(sha256Hex(copy)),
      contentType: options.contentType,
      cacheControl: options.cacheControl,
      contentDisposition: options.contentDisposition,
    }
    this.objects.set(key, entry)
    return { etag: entry.etag, contentType: entry.contentType, size: copy.byteLength }
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort()
  }

  async rewriteMetadata(key: string, meta: ObjectRewriteMetadata): Promise<ObjectHead> {
    this.rewriteCalls.push({ key, meta })
    const entry = this.objects.get(key)
    if (!entry) throw new Error(`missing object ${key}`)
    if (entry.forceConflict || normalizeEtag(entry.etag) !== normalizeEtag(meta.expectedEtag)) {
      throw new ObjectStorePreconditionError(`If-Match failed for ${key}`)
    }
    entry.contentType = meta.contentType
    entry.cacheControl = meta.cacheControl
    entry.contentDisposition = meta.contentDisposition
    // Metadata-only rewrite: body hash (etag) stays; production S3 may change ETag.
    entry.etag = quoteEtag(`${normalizeEtag(entry.etag)}-meta`)
    return { etag: entry.etag, contentType: entry.contentType, size: entry.body.byteLength }
  }
  seed(key: string, body: Uint8Array, contentType: string): void {
    this.objects.set(key, {
      body: new Uint8Array(body),
      etag: quoteEtag(sha256Hex(body)),
      contentType,
      metadata: { keep: 'yes' },
    })
  }
}

test('parseImageMimeRepairArgs defaults dry-run and prefix images/', () => {
  const parsed = parseImageMimeRepairArgs([])
  assert.equal(parsed.apply, false)
  assert.equal(parsed.prefix, 'images/')
  assert.equal(parsed.concurrency, 8)
  assert.equal(parsed.failFast, false)
  assert.equal(parsed.iAmSureProduction, false)
  assert.equal(parsed.key, null)
  assert.equal(parsed.reportPath, null)
})

test('parseImageMimeRepairArgs reads apply concurrency key report fail-fast production flag', () => {
  const parsed = parseImageMimeRepairArgs([
    '--apply',
    '--concurrency',
    '4',
    '--key',
    KEY_A,
    '--report',
    './mime-repair.json',
    '--fail-fast',
    '--i-am-sure-production',
    '--prefix',
    'images/',
  ])
  assert.equal(parsed.apply, true)
  assert.equal(parsed.concurrency, 4)
  assert.equal(parsed.key, KEY_A)
  assert.equal(parsed.reportPath, './mime-repair.json')
  assert.equal(parsed.failFast, true)
  assert.equal(parsed.iAmSureProduction, true)
  assert.equal(parsed.prefix, 'images/')
})

test('assertProductionRepairAllowed refuses production env without dual gate', () => {
  assert.throws(
    () => assertProductionRepairAllowed({
      apply: true,
      env: { AIRINGCAL_ENV: 'production' },
      bucket: 'airingcal-staging-public',
      iAmSureProduction: false,
    }),
    /production/,
  )
  assert.throws(
    () => assertProductionRepairAllowed({
      apply: true,
      env: { AIRINGCAL_ENV: 'development' },
      bucket: 'airingcal-production',
      iAmSureProduction: true,
    }),
    /AIRINGCAL_ENV=production/,
  )
})

test('assertProductionRepairAllowed allows production only with both gates', () => {
  assert.doesNotThrow(() => assertProductionRepairAllowed({
    apply: true,
    env: { AIRINGCAL_ENV: 'production' },
    bucket: 'airingcal-production',
    iAmSureProduction: true,
  }))
})

test('assertProductionRepairAllowed refuses production-named bucket on apply without dual gate', () => {
  assert.throws(
    () => assertProductionRepairAllowed({
      apply: true,
      env: { AIRINGCAL_ENV: 'development' },
      bucket: 'airingcal-production',
      iAmSureProduction: false,
    }),
    /production/,
  )
})

test('dry-run reports would_fix without calling rewriteMetadata', async () => {
  const store = new RepairStoreDouble()
  const jpeg = jpegBytes()
  store.seed(KEY_A, jpeg, 'application/octet-stream')
  store.seed(KEY_THUMB, pngBytes(), 'image/webp')

  const report = await runImageMimeRepair({
    store,
    apply: false,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
  })

  assert.equal(report.status, 'dry_run')
  assert.equal(report.counts.would_fix, 1)
  assert.equal(report.counts.ok, 0)
  assert.equal(report.counts.scanned, 1)
  assert.equal(store.rewriteCalls.length, 0)
  const item = report.items.find((row) => row.key === KEY_A)
  assert.ok(item)
  assert.equal(item.status, 'would_fix')
  assert.equal(item.oldType, 'application/octet-stream')
  assert.equal(item.newType, 'image/jpeg')
  assert.equal(item.content_sha256, sha256Hex(jpeg))
})

test('already image/* content types are ok and idempotent on apply', async () => {
  const store = new RepairStoreDouble()
  store.seed(KEY_A, jpegBytes(), 'image/jpeg')

  const dry = await runImageMimeRepair({
    store,
    apply: false,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
  })
  assert.equal(dry.counts.ok, 1)
  assert.equal(dry.counts.would_fix, 0)

  const applied = await runImageMimeRepair({
    store,
    apply: true,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
  })
  assert.equal(applied.counts.ok, 1)
  assert.equal(applied.counts.repaired, 0)
  assert.equal(store.rewriteCalls.length, 0)
})

test('apply rewrites metadata, verifies hash, leaves body bytes unchanged', async () => {
  const store = new RepairStoreDouble()
  const jpeg = jpegBytes()
  store.seed(KEY_A, jpeg, 'application/octet-stream')
  const beforeHash = sha256Hex(jpeg)

  const report = await runImageMimeRepair({
    store,
    apply: true,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
    cdn: { head: async () => ({ contentType: 'image/jpeg' }) },
  })

  assert.equal(report.status, 'applied')
  assert.equal(report.counts.repaired, 1)
  assert.equal(store.rewriteCalls.length, 1)
  assert.equal(store.rewriteCalls[0]?.meta.contentType, 'image/jpeg')
  assert.equal(store.rewriteCalls[0]?.meta.cacheControl, IMAGE_CACHE_CONTROL)
  assert.equal(store.rewriteCalls[0]?.meta.contentDisposition, IMAGE_CONTENT_DISPOSITION)
  assert.equal(store.rewriteCalls[0]?.meta.preserveUserMetadata, true)

  const after = await store.get(KEY_A)
  assert.ok(after)
  assert.equal(after.contentType, 'image/jpeg')
  assert.equal(sha256Hex(after.body), beforeHash)
  const item = report.items.find((row) => row.key === KEY_A)
  assert.equal(item?.status, 'repaired')
  assert.equal(item?.content_sha256, beforeHash)
})

test('unknown bytes are skipped_unknown without rewrite', async () => {
  const store = new RepairStoreDouble()
  store.seed(KEY_A, unknownBytes(), 'application/octet-stream')

  const report = await runImageMimeRepair({
    store,
    apply: true,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
  })

  assert.equal(report.counts.skipped_unknown, 1)
  assert.equal(report.counts.repaired, 0)
  assert.equal(store.rewriteCalls.length, 0)
  assert.equal(report.items[0]?.status, 'skipped_unknown')
})

test('IfMatch conflict is recorded and continue by default', async () => {
  const store = new RepairStoreDouble()
  store.seed(KEY_A, jpegBytes(), 'application/octet-stream')
  store.seed(KEY_B, pngBytes(), 'application/octet-stream')
  const entryA = store.objects.get(KEY_A)!
  entryA.forceConflict = true

  const report = await runImageMimeRepair({
    store,
    apply: true,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
    cdn: { head: async () => ({ contentType: 'image/png' }) },
  })

  assert.equal(report.counts.conflict, 1)
  assert.equal(report.counts.repaired, 1)
  assert.ok(report.items.some((row) => row.key === KEY_A && row.status === 'conflict'))
  assert.ok(report.items.some((row) => row.key === KEY_B && row.status === 'repaired'))
})

test('fail-fast aborts after first conflict', async () => {
  const store = new RepairStoreDouble()
  // Deterministic list order: HASH_A then HASH_B then HASH_C
  store.seed(KEY_A, jpegBytes(), 'application/octet-stream')
  store.seed(KEY_B, pngBytes(), 'application/octet-stream')
  store.seed(KEY_C, jpegBytes(), 'application/octet-stream')
  store.objects.get(KEY_A)!.forceConflict = true

  const report = await runImageMimeRepair({
    store,
    apply: true,
    failFast: true,
    concurrency: 1,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
  })

  assert.equal(report.counts.conflict, 1)
  assert.ok(report.counts.repaired + report.counts.would_fix === 0 || report.aborted === true)
  assert.equal(report.aborted, true)
  // With concurrency 1 and fail-fast, later keys must not be rewritten.
  assert.ok(store.rewriteCalls.every((call) => call.key !== KEY_B && call.key !== KEY_C))
})

test('--key limits repair to a single original', async () => {
  const store = new RepairStoreDouble()
  store.seed(KEY_A, jpegBytes(), 'application/octet-stream')
  store.seed(KEY_B, pngBytes(), 'application/octet-stream')

  const report = await runImageMimeRepair({
    store,
    apply: false,
    key: KEY_B,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
  })

  assert.equal(report.counts.scanned, 1)
  assert.equal(report.counts.would_fix, 1)
  assert.equal(report.items[0]?.key, KEY_B)
  assert.equal(report.items[0]?.newType, 'image/png')
})

test('hash verification failure is verify_failed when body changes underfoot', async () => {
  const store = new RepairStoreDouble()
  const jpeg = jpegBytes()
  store.seed(KEY_A, jpeg, 'application/octet-stream')

  const originalRewrite = store.rewriteMetadata.bind(store)
  store.rewriteMetadata = async (key, meta) => {
    const head = await originalRewrite(key, meta)
    // Corrupt body after rewrite to simulate concurrent overwrite that slipped past IfMatch.
    const entry = store.objects.get(key)!
    entry.body = unknownBytes()
    return head
  }

  const report = await runImageMimeRepair({
    store,
    apply: true,
    prefix: 'images/',
    env: { AIRINGCAL_ENV: 'development' },
    bucket: 'airingcal-staging-public',
  })

  assert.equal(report.counts.verify_failed, 1)
  assert.equal(report.items[0]?.status, 'verify_failed')
})

test('CDN still serving octet-stream records cdn_stale_pending', async () => {
  const store = new RepairStoreDouble()
  store.seed(KEY_A, jpegBytes(), 'application/octet-stream')
  const cdnHeads: string[] = []
  const cdn: ImageMimeRepairCdnClient = {
    head: async (url) => {
      cdnHeads.push(url)
      return { contentType: 'application/octet-stream' }
    },
    purge: async () => false,
  }

  const report = await runImageMimeRepair({
    store,
    apply: true,
    prefix: 'images/',
    env: {
      AIRINGCAL_ENV: 'development',
      AIRINGCAL_PUBLIC_BASE_URL: 'https://cdn.example',
    },
    bucket: 'airingcal-staging-public',
    cdn,
  })

  assert.equal(report.counts.repaired, 1)
  assert.equal(report.counts.cdn_stale_pending, 1)
  assert.ok(report.items.some((row) => row.status === 'cdn_stale_pending'))
  assert.ok(cdnHeads[0]?.includes(KEY_A))
  assert.equal(report.complete, false)
})

test('writes report JSON when reportPath set', async () => {
  const store = new RepairStoreDouble()
  store.seed(KEY_A, jpegBytes(), 'application/octet-stream')
  const dir = mkdtempSync(join(tmpdir(), 'mime-repair-'))
  const reportPath = join(dir, 'mime-repair.json')
  try {
    const report = await runImageMimeRepair({
      store,
      apply: false,
      prefix: 'images/',
      reportPath,
      env: { AIRINGCAL_ENV: 'development' },
      bucket: 'airingcal-staging-public',
    })
    const written = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(written.status, 'dry_run')
    assert.equal(written.counts.would_fix, report.counts.would_fix)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
