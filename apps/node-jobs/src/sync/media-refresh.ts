import { createHash } from 'node:crypto'
import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import { imageRef, type SubjectImageMap } from '@airing-cal/domain'
import type { CloudflareD1Client } from '../adapters/cloudflare-d1.ts'
import type { R2Store } from '../adapters/r2-store.ts'
import type { RunContext } from '../adapters/run-context.ts'
import {
  type MediaRefreshFailure,
  type MediaRefreshPort,
  type MediaRefreshRequest,
  type MediaRefreshSummary,
  type MediaSubjectSource,
} from './media-port.ts'
import { emitProgress } from './sync-progress.ts'

const USER_AGENT = 'markd3ng/AiringCal (https://github.com/markd3ng/AiringCal)'
const IMAGE_HOSTS = new Set(['lain.bgm.tv', 'lain.bangumi.tv'])
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const DAY_SECONDS = 86_400
const SUCCESS_SPREAD_SECONDS = 172_801
const PUBLISH_RESERVE_MS = 30_000
const PROGRESS_EVERY = 5
const PROGRESS_MIN_MS = 2_000
const KEY_PATTERN = /^images\/([0-9a-f]{64})\/original$/

function emitMediaProgress(done: number, total: number, succeeded: number, failed: number): void {
  emitProgress('media', 'media_progress', done, total, { succeeded, failed })
}

const ENSURE_SUBJECT_MEDIA = `CREATE TABLE IF NOT EXISTS subject_media (
  subject_id INTEGER PRIMARY KEY,
  detail_json TEXT,
  detail_hash TEXT,
  media_hash TEXT,
  nsfw INTEGER NOT NULL DEFAULT 0 CHECK (nsfw IN (0, 1)),
  source_image_common_url TEXT,
  source_image_large_url TEXT,
  r2_image_common_key TEXT,
  r2_image_large_key TEXT,
  checked_at INTEGER,
  next_refresh_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER,
  error_code TEXT
)`

const SELECT_SUBJECT_MEDIA = `SELECT subject_id, source_image_common_url, source_image_large_url,
  r2_image_common_key, r2_image_large_key, next_refresh_at, retry_count, error_code
  FROM subject_media`

const SELECT_IMAGE_KEYS = 'SELECT subject_id, r2_image_common_key, r2_image_large_key FROM subject_media'

const UPSERT_SUBJECT_MEDIA = `INSERT INTO subject_media (
  subject_id, detail_json, detail_hash, media_hash, nsfw,
  source_image_common_url, source_image_large_url,
  r2_image_common_key, r2_image_large_key,
  checked_at, next_refresh_at, retry_count, retry_after, error_code
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(subject_id) DO UPDATE SET
  detail_json = COALESCE(excluded.detail_json, subject_media.detail_json),
  detail_hash = COALESCE(excluded.detail_hash, subject_media.detail_hash),
  media_hash = excluded.media_hash,
  nsfw = excluded.nsfw,
  source_image_common_url = excluded.source_image_common_url,
  source_image_large_url = excluded.source_image_large_url,
  r2_image_common_key = excluded.r2_image_common_key,
  r2_image_large_key = excluded.r2_image_large_key,
  checked_at = excluded.checked_at,
  next_refresh_at = excluded.next_refresh_at,
  retry_count = excluded.retry_count,
  retry_after = excluded.retry_after,
  error_code = excluded.error_code`

type ImageSize = 'common' | 'large'

interface StoredMedia {
  source: Record<ImageSize, string | null>
  key: Record<ImageSize, string | null>
  nextRefreshAt: number | null
  retryCount: number
  errorCode: string | null
}

export interface SubjectMediaRefreshDeps {
  db: CloudflareD1Client
  store: R2Store
  fetchImage?: (url: string, signal: AbortSignal) => Promise<Response>
  concurrency?: number
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function textAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 4) === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && textAt(bytes, 4, 4) === 'ftyp') {
    const brand = textAt(bytes, 8, 4)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  return null
}

export type BangumiImageSizes = {
  common?: string
  large?: string
  medium?: string
  small?: string
  grid?: string
}

export function coalesceSubjectImageUrls(images: BangumiImageSizes | undefined): { common?: string; large?: string } {
  if (!images) return {}
  const common = images.common || images.medium || images.small || images.grid
  const large = images.large || images.common || images.medium
  return {
    ...(typeof common === 'string' && common ? { common } : {}),
    ...(typeof large === 'string' && large ? { large } : {}),
  }
}

function mergeImageFields(
  into: { common?: string; large?: string },
  from: BangumiImageSizes | undefined,
): void {
  if (!from) return
  for (const size of ['common', 'large'] as const) {
    const value = from[size]
    if (typeof value === 'string' && value && !into[size]) into[size] = value
  }
}

export function bangumiImageUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const href = value.trim().startsWith('//') ? `https:${value.trim()}` : value.trim()
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port) return null
  if (url.protocol === 'http:') {
    url = new URL(url.href.replace(/^http:/i, 'https:'))
  } else if (url.protocol !== 'https:') {
    return null
  }
  return url.href
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

function storedFromRow(row: Record<string, unknown>): StoredMedia {
  return {
    source: {
      common: nullableText(row.source_image_common_url),
      large: nullableText(row.source_image_large_url),
    },
    key: {
      common: nullableText(row.r2_image_common_key),
      large: nullableText(row.r2_image_large_key),
    },
    nextRefreshAt: nullableInt(row.next_refresh_at),
    retryCount: nullableInt(row.retry_count) ?? 0,
    errorCode: nullableText(row.error_code),
  }
}

function sourcesFor(subject: MediaSubjectSource): Record<ImageSize, string | null> {
  const coalesced = coalesceSubjectImageUrls(subject.images)
  return {
    common: bangumiImageUrl(coalesced.common),
    // Do not treat calendar `common` as `large`; detail enrich supplies real large URLs.
    large: bangumiImageUrl(subject.images.large),
  }
}

function shouldSkip(row: StoredMedia | undefined, sources: Record<ImageSize, string | null>, nowSec: number): boolean {
  if (!row || row.nextRefreshAt === null || row.nextRefreshAt <= nowSec) return false
  for (const size of ['common', 'large'] as const) {
    if (sources[size] !== row.source[size]) return false
  }
  if (row.errorCode) return true
  for (const size of ['common', 'large'] as const) {
    if (sources[size] && !row.key[size]) return false
  }
  return true
}

function mediaWorkPriority(
  subject: MediaSubjectSource,
  existing: Map<number, StoredMedia>,
  sources: Record<ImageSize, string | null>,
): number {
  const row = existing.get(subject.subjectId)
  if (row?.errorCode) return 0
  for (const size of ['common', 'large'] as const) {
    if (sources[size] && !row?.key[size]) return 1
  }
  if (!row) return 2
  return 3
}

export interface SubjectMediaPublishHint {
  errorCode: string | null
  hasSourceCommon: boolean
  hasSourceLarge: boolean
}

export async function loadSubjectMediaPublishHints(db: CloudflareD1Client): Promise<Map<number, SubjectMediaPublishHint>> {
  await ensureSubjectMedia(db)
  const hints = new Map<number, SubjectMediaPublishHint>()
  for (const row of await db.query(SELECT_SUBJECT_MEDIA)) {
    const subjectId = Number(row.subject_id)
    if (!Number.isSafeInteger(subjectId) || subjectId <= 0) continue
    hints.set(subjectId, {
      errorCode: nullableText(row.error_code),
      hasSourceCommon: Boolean(nullableText(row.source_image_common_url)),
      hasSourceLarge: Boolean(nullableText(row.source_image_large_url)),
    })
  }
  return hints
}

function refFromKey(value: unknown) {
  if (typeof value !== 'string') return null
  const match = KEY_PATTERN.exec(value)
  if (!match?.[1]) return null
  const ref = imageRef(match[1])
  return ref.r2_key === value ? ref : null
}

async function ensureSubjectMedia(db: CloudflareD1Client): Promise<void> {
  await db.query(ENSURE_SUBJECT_MEDIA)
}

export async function loadSubjectImageMap(db: CloudflareD1Client): Promise<SubjectImageMap> {
  await ensureSubjectMedia(db)
  const rows = await db.query(SELECT_IMAGE_KEYS)
  const imageMap: SubjectImageMap = new Map()
  for (const row of rows) {
    const subjectId = Number(row.subject_id)
    if (!Number.isSafeInteger(subjectId) || subjectId <= 0) continue
    const common = refFromKey(row.r2_image_common_key)
    const large = refFromKey(row.r2_image_large_key)
    if (!common && !large) continue
    imageMap.set(subjectId, { common, large })
  }
  return imageMap
}

export function mediaSubjectsFromFetch(input: CompleteFullFetch): MediaSubjectSource[] {
  const merged = new Map<number, MediaSubjectSource & { pub: boolean }>()
  const touch = (
    subjectId: number,
    nsfw: boolean,
    images: BangumiImageSizes | undefined,
    pub: boolean,
  ) => {
    if (!Number.isSafeInteger(subjectId) || subjectId <= 0) return
    let row = merged.get(subjectId)
    if (!row) {
      row = { subjectId, nsfw: false, images: {}, pub: false }
      merged.set(subjectId, row)
    }
    if (nsfw) row.nsfw = true
    if (!pub) return
    row.pub = true
    mergeImageFields(row.images, images)
  }

  for (const entry of input.collections) {
    touch(
      entry.collection.subject_id,
      entry.collection.subject?.nsfw === true,
      entry.collection.subject?.images,
      entry.collection.private !== true,
    )
  }
  for (const day of input.calendar) {
    for (const item of day.items) {
      touch(item.id, item.nsfw === true, item.images, true)
    }
  }

  return [...merged.values()]
    .filter((row) => row.pub)
    .map(({ pub: _pub, ...row }) => row)
    .sort((a, b) => a.subjectId - b.subjectId)
}

async function defaultFetchImage(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8',
    },
    signal,
  })
}

async function readImage(response: Response): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (response.url && !bangumiImageUrl(response.url)) {
    await response.body?.cancel()
    throw new Error('MEDIA_URL_INVALID')
  }
  const declared = Number(response.headers.get('content-length'))
  if (response.status !== 200 || (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES)) {
    await response.body?.cancel()
    throw new Error('MEDIA_IMAGE_INVALID')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('MEDIA_IMAGE_INVALID')
  const contentType = sniffImage(bytes)
  if (!contentType) throw new Error('MEDIA_IMAGE_INVALID')
  return { bytes, contentType }
}

async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export function createSubjectMediaRefresh(deps: SubjectMediaRefreshDeps): MediaRefreshPort {
  const fetchImage = deps.fetchImage ?? defaultFetchImage
  const concurrency = deps.concurrency ?? 4

  return {
    async refresh(context: RunContext & { observedAt: string }, request?: MediaRefreshRequest): Promise<MediaRefreshSummary> {
      const summary: MediaRefreshSummary = { selected: 0, succeeded: 0, failed: 0, failures: [], large_hashes_persisted: [] }
      const largeHashesPersisted = new Set<string>()
      const subjects = request?.subjects ?? []
      await ensureSubjectMedia(deps.db)
      const existing = new Map<number, StoredMedia>()
      for (const row of await deps.db.query(SELECT_SUBJECT_MEDIA)) {
        const subjectId = Number(row.subject_id)
        if (Number.isSafeInteger(subjectId) && subjectId > 0) existing.set(subjectId, storedFromRow(row))
      }

      const nowSec = Math.floor(Date.parse(context.observedAt) / 1000)
      const work = subjects.filter((subject) => {
        const sources = sourcesFor(subject)
        if (!sources.common && !sources.large) return false
        return !shouldSkip(existing.get(subject.subjectId), sources, nowSec)
      })
      work.sort((a, b) => {
        const pa = mediaWorkPriority(a, existing, sourcesFor(a))
        const pb = mediaWorkPriority(b, existing, sourcesFor(b))
        return pa - pb || a.subjectId - b.subjectId
      })
      const total = work.length
      if (total > 0) {
        console.log(JSON.stringify({
          status: 'info',
          stage: 'media',
          message: `refresh ${total} subject image(s)`,
          total,
        }))
      }
      let processed = 0
      let lastProgressAt = 0
      const maybeProgress = () => {
        if (total <= 0) return
        const now = Date.now()
        if (processed >= total || processed % PROGRESS_EVERY === 0 || now - lastProgressAt >= PROGRESS_MIN_MS) {
          emitMediaProgress(processed, total, summary.succeeded, summary.failed)
          lastProgressAt = now
        }
      }
      await mapPool(work, concurrency, async (subject) => {
        if (context.signal.aborted || context.deadlineAt - Date.now() <= PUBLISH_RESERVE_MS) return
        summary.selected += 1
        const sources = sourcesFor(subject)
        const current = existing.get(subject.subjectId)
        const keys: Record<ImageSize, string | null> = {
          common: current?.key.common ?? null,
          large: current?.key.large ?? null,
        }
        let failed = false
        const failedSizes: ImageSize[] = []
        const downloaded = new Map<string, { bytes: Uint8Array; contentType: string }>()
        try {
          for (const size of ['common', 'large'] as const) {
            const url = sources[size]
            if (!url) {
              keys[size] = null
              continue
            }
            try {
              let image = downloaded.get(url)
              if (!image) {
                const signal = AbortSignal.any([context.signal, AbortSignal.timeout(20_000)])
                image = await readImage(await fetchImage(url, signal))
                downloaded.set(url, image)
              }
              const digest = sha256(image.bytes)
              const reference = imageRef(digest)
              if (keys[size] !== reference.r2_key) await deps.store.put(reference.r2_key, image.bytes, image.contentType)
              keys[size] = reference.r2_key
            } catch {
              failed = true
              failedSizes.push(size)
            }
          }
        } catch {
          failed = true
        }

        const mediaHash = sha256(JSON.stringify({ common: keys.common, large: keys.large }))
        const retryCount = failed ? (current?.retryCount ?? 0) + 1 : 0
        const nextRefreshAt = failed
          ? nowSec
          : nowSec + 6 * DAY_SECONDS + (subject.subjectId * 997 % SUCCESS_SPREAD_SECONDS)
        await deps.db.query(UPSERT_SUBJECT_MEDIA, [
          subject.subjectId,
          null,
          null,
          mediaHash,
          subject.nsfw ? 1 : 0,
          sources.common,
          sources.large,
          keys.common,
          keys.large,
          nowSec,
          nextRefreshAt,
          retryCount,
          failed ? nextRefreshAt : null,
          failed ? 'MEDIA_IMAGE_FAILED' : null,
        ])
        if (!failed && keys.large && !failedSizes.includes('large')) {
          const match = KEY_PATTERN.exec(keys.large)
          if (match?.[1]) largeHashesPersisted.add(match[1])
        }
        if (failed) {
          summary.failed += 1
          const failure: MediaRefreshFailure = {
            subject_id: subject.subjectId,
            error_code: 'MEDIA_IMAGE_FAILED',
            sizes: failedSizes.length > 0 ? failedSizes : (['common', 'large'] as const).filter((size) => Boolean(sources[size])),
          }
          summary.failures.push(failure)
          console.log(JSON.stringify({
            status: 'info',
            stage: 'media_failed',
            subject_id: failure.subject_id,
            error_code: failure.error_code,
            sizes: failure.sizes,
            retry_count: retryCount,
          }))
        } else summary.succeeded += 1
        processed += 1
        maybeProgress()
      })

      if (total > 0 && processed > 0) {
        emitMediaProgress(processed, total, summary.succeeded, summary.failed)
      }
      summary.large_hashes_persisted = [...largeHashesPersisted]
      console.log(JSON.stringify({
        stage: 'media',
        selected: summary.selected,
        succeeded: summary.succeeded,
        failed: summary.failed,
        failures: summary.failures,
        large_hashes_persisted: summary.large_hashes_persisted.length,
      }))
      return summary
    },
  }
}
