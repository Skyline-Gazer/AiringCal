import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { assembleFullFetch, type BgmCollection } from '@airing-cal/bgm-api'
import { parsePublicSnapshotV1 } from '@airing-cal/domain'
import type { CloudflareD1Client } from '../adapters/cloudflare-d1.ts'
import type { R2Store } from '../adapters/r2-store.ts'
import { createRunContext } from '../adapters/run-context.ts'
import { noopMediaRefresh } from './media-port.ts'
import {
  createSubjectMediaRefresh,
  loadSubjectImageMap,
  MEDIA_IMAGE_FAILED_EXHAUSTED,
  mediaRetryDelaySeconds,
  mediaSubjectsFromFetch,
} from './media-refresh.ts'
import { runSyncPipeline } from './pipeline.ts'

const COMMON_URL = 'https://lain.bgm.tv/pic/cover/c/common.jpg'
const LARGE_URL = 'https://lain.bgm.tv/pic/cover/l/large.jpg'
const COMMON_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])
const LARGE_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9])
const gitSha = 'a'.repeat(40)

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function collection(subjectId: number, images: { common: string; large: string }, isPrivate = false): BgmCollection {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 0,
    type: 3,
    comment: '',
    tags: [],
    ep_status: 1,
    vol_status: 0,
    updated_at: '2026-01-01T00:00:00.000Z',
    private: isPrivate,
    subject: {
      id: subjectId,
      type: 2,
      name: 'Name',
      name_cn: '中文',
      summary: 'summary',
      nsfw: false,
      date: '2026-01-01',
      eps: 12,
      total_episodes: 12,
      images: {
        large: images.large,
        common: images.common,
        medium: images.common,
        small: images.common,
        grid: images.common,
      },
      rating: { score: 7, rank: 100, total: 10 },
    },
  }
}

function fetchInput(entry: BgmCollection) {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 1, data: [entry] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

class MemoryR2 implements R2Store {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()

  async put(key: string, body: Uint8Array, contentType?: string): Promise<void> {
    this.objects.set(key, { bytes: body, contentType })
  }

  async get(key: string, maximumBytes = 32 * 1024 * 1024): Promise<Uint8Array | null> {
    const value = this.objects.get(key)
    if (!value || value.bytes.byteLength > maximumBytes) return null
    return value.bytes
  }

  async verifiedPut(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    await this.put(key, bytes, contentType)
  }

  close(): void {}
}

class MemoryD1 implements CloudflareD1Client {
  leaseOwner: string | null = null
  media = new Map<number, Record<string, unknown>>()

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    if (sql.includes('INSERT INTO airingcal_job_leases')) {
      if (this.leaseOwner && this.leaseOwner !== params[1]) return []
      this.leaseOwner = String(params[1])
      return [{ owner: this.leaseOwner }]
    }
    if (sql.includes('SELECT owner FROM airingcal_job_leases')) {
      return this.leaseOwner === params[1] ? [{ owner: this.leaseOwner }] : []
    }
    if (sql.includes('DELETE FROM airingcal_job_leases')) {
      if (this.leaseOwner === params[1]) this.leaseOwner = null
      return []
    }
    if (sql.includes('CREATE TABLE') && sql.includes('subject_media')) return []
    if (sql.includes('FROM subject_media')) return [...this.media.values()]
    if (sql.includes('INSERT INTO subject_media')) {
      const [
        subject_id,
        detail_json,
        detail_hash,
        media_hash,
        nsfw,
        source_image_common_url,
        source_image_large_url,
        r2_image_common_key,
        r2_image_large_key,
        checked_at,
        next_refresh_at,
        retry_count,
        retry_after,
        error_code,
      ] = params
      const row = {
        subject_id,
        detail_json,
        detail_hash,
        media_hash,
        nsfw,
        source_image_common_url,
        source_image_large_url,
        r2_image_common_key,
        r2_image_large_key,
        checked_at,
        next_refresh_at,
        retry_count,
        retry_after,
        error_code,
      }
      this.media.set(Number(subject_id), row)
      return []
    }
    return []
  }

  export(): Promise<unknown> {
    return Promise.resolve({})
  }
}

function imageResponse(url: string): Response {
  const bytes = url.includes('/l/large') ? LARGE_BYTES : COMMON_BYTES
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } })
}

test('media refresh stores Bangumi images in R2 and subject_media', async () => {
  const store = new MemoryR2()
  const db = new MemoryD1()
  const fetched: string[] = []
  const refresh = createSubjectMediaRefresh({
    db,
    store,
    fetchImage: async (url) => {
      fetched.push(url)
      return imageResponse(url)
    },
  })
  const input = fetchInput(collection(42, { common: `//lain.bgm.tv/pic/cover/c/common.jpg`, large: LARGE_URL }))
  const summary = await refresh.refresh(
    { ...createRunContext({ runId: 'run-media', deadlineAt: Date.now() + 60_000 }), observedAt: '2023-11-14T22:13:20.000Z' },
    { subjects: mediaSubjectsFromFetch(input) },
  )

  const commonHash = sha256(COMMON_BYTES)
  const largeHash = sha256(LARGE_BYTES)
  assert.deepEqual(summary, { selected: 1, succeeded: 1, failed: 0, failures: [], large_hashes_persisted: [largeHash] })
  assert.deepEqual(fetched.sort(), [COMMON_URL, LARGE_URL].sort())
  assert.ok(store.objects.has(`images/${commonHash}/original`))
  assert.equal(store.objects.get(`images/${commonHash}/original`)?.contentType, 'image/jpeg')
  const row = db.media.get(42)
  assert.equal(row?.r2_image_common_key, `images/${commonHash}/original`)
  assert.equal(row?.r2_image_large_key, `images/${largeHash}/original`)
  assert.equal(row?.source_image_common_url, COMMON_URL)
  assert.equal(row?.error_code, null)

  const imageMap = await loadSubjectImageMap(db)
  assert.equal(imageMap.get(42)?.common?.hash, commonHash)
  assert.equal(imageMap.get(42)?.common?.uri, `/image/${commonHash}`)
  assert.equal(imageMap.get(42)?.large?.r2_key, `images/${largeHash}/original`)
})

test('media refresh skips fresh subject_media rows and rejects non-Bangumi hosts', async () => {
  const store = new MemoryR2()
  const db = new MemoryD1()
  db.media.set(7, {
    subject_id: 7,
    source_image_common_url: COMMON_URL,
    source_image_large_url: LARGE_URL,
    r2_image_common_key: `images/${'a'.repeat(64)}/original`,
    r2_image_large_key: `images/${'b'.repeat(64)}/original`,
    next_refresh_at: 1_700_000_000 + 86_400,
    retry_count: 0,
    error_code: null,
  })
  const fetched: string[] = []
  const refresh = createSubjectMediaRefresh({
    db,
    store,
    fetchImage: async (url) => {
      fetched.push(url)
      return imageResponse(url)
    },
  })
  const context = { ...createRunContext({ runId: 'run-skip', deadlineAt: Date.now() + 60_000 }), observedAt: '2023-11-14T22:13:20.000Z' }
  const fresh = await refresh.refresh(context, {
    subjects: mediaSubjectsFromFetch(fetchInput(collection(7, { common: COMMON_URL, large: LARGE_URL }))),
  })
  assert.deepEqual(fresh, { selected: 0, succeeded: 0, failed: 0, failures: [], large_hashes_persisted: [] })

  const rejected = await refresh.refresh(context, {
    subjects: [{ subjectId: 8, nsfw: false, images: { common: 'https://example.com/a.jpg', large: 'https://example.com/b.jpg' } }],
  })
  assert.deepEqual(rejected, { selected: 0, succeeded: 0, failed: 0, failures: [], large_hashes_persisted: [] })
  assert.deepEqual(fetched, [])
})

test('media refresh leaves time to publish when the run deadline is close', async () => {
  const fetched: string[] = []
  const refresh = createSubjectMediaRefresh({
    db: new MemoryD1(),
    store: new MemoryR2(),
    fetchImage: async (url) => {
      fetched.push(url)
      return imageResponse(url)
    },
  })
  const summary = await refresh.refresh(
    { ...createRunContext({ runId: 'run-deadline', deadlineAt: Date.now() + 1000 }), observedAt: '2023-11-14T22:13:20.000Z' },
    { subjects: mediaSubjectsFromFetch(fetchInput(collection(42, { common: COMMON_URL, large: LARGE_URL }))) },
  )
  assert.deepEqual(summary, { selected: 0, succeeded: 0, failed: 0, failures: [], large_hashes_persisted: [] })
  assert.deepEqual(fetched, [])
})

test('media refresh logs failed subject ids and retries failed rows on the next run', async () => {
  const store = new MemoryR2()
  const db = new MemoryD1()
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
    originalLog(...args)
  }
  try {
    const refresh = createSubjectMediaRefresh({
      db,
      store,
      fetchImage: async (url) => {
        if (url.includes('/c/common')) return new Response('bad', { status: 500 })
        return imageResponse(url)
      },
    })
    const context = { ...createRunContext({ runId: 'run-fail', deadlineAt: Date.now() + 60_000 }), observedAt: '2023-11-14T22:13:20.000Z' }
    const first = await refresh.refresh(context, {
      subjects: mediaSubjectsFromFetch(fetchInput(collection(120224, { common: COMMON_URL, large: LARGE_URL }))),
    })
    assert.equal(first.failed, 1)
    assert.deepEqual(first.failures, [{ subject_id: 120224, error_code: 'MEDIA_IMAGE_FAILED', sizes: ['common'] }])
    assert.ok(logs.some((line) => line.includes('"stage":"media_failed"') && line.includes('120224')))

    const second = await refresh.refresh(
      { ...createRunContext({ runId: 'run-fail-2', deadlineAt: Date.now() + 60_000 }), observedAt: '2023-11-15T22:13:20.000Z' },
      { subjects: mediaSubjectsFromFetch(fetchInput(collection(120224, { common: COMMON_URL, large: LARGE_URL }))) },
    )
    assert.equal(second.selected, 1)
  } finally {
    console.log = originalLog
  }
})

test('mediaSubjectsFromFetch ignores private collections and keeps calendar images', () => {
  const input = assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 1, data: [collection(3, { common: COMMON_URL, large: LARGE_URL }, true)] }] }],
    [{
      weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 },
      items: [{ id: 9, type: 2, name: 'Cal', images: { common: COMMON_URL, large: LARGE_URL } }],
    }],
    1_700_000_000,
  )
  assert.deepEqual(mediaSubjectsFromFetch(input).map((subject) => subject.subjectId), [9])
})

test('runSyncPipeline publishes cached image refs and bumps generation', async () => {
  const store = new MemoryR2()
  const db = new MemoryD1()
  const input = fetchInput(collection(42, { common: COMMON_URL, large: LARGE_URL }))
  const base = {
    run: createRunContext({ runId: 'run-pub', deadlineAt: Date.now() + 60_000 }),
    db,
    store,
    syncConfig: { users: [{ userId: '1', username: 'u' }], primaryUserId: '1', gitSha },
    leaseName: 'airingcal-data-plane',
    leaseSeconds: 900,
    fetchInput: async () => input,
    now: () => 1_700_000_000_000,
  }
  const first = await runSyncPipeline({ ...base, media: noopMediaRefresh })
  assert.equal(first.generation, 1)
  assert.equal(first.media.selected, 0)

  const refresh = createSubjectMediaRefresh({
    db,
    store,
    fetchImage: async (url) => imageResponse(url),
  })
  const second = await runSyncPipeline({
    ...base,
    run: createRunContext({ runId: 'run-pub-2', deadlineAt: Date.now() + 60_000 }),
    media: refresh,
  })
  assert.equal(second.status, 'ok')
  assert.equal(second.generation, 2)
  assert.equal(second.media.selected, 1)
  assert.equal(second.media.succeeded, 1)

  const snapshotKey = [...store.objects.keys()].find((key) => key.startsWith('snapshots/v1/2-'))
  assert.ok(snapshotKey)
  const snapshot = await parsePublicSnapshotV1(JSON.parse(new TextDecoder().decode(store.objects.get(snapshotKey!)!.bytes)))
  const item = snapshot.collections.watching[0]
  assert.equal(item?.images.common?.hash, sha256(COMMON_BYTES))
  assert.equal(item?.images.common?.uri, `/image/${sha256(COMMON_BYTES)}`)
  assert.equal(item?.image_status.common, 'cached')
  assert.equal(item?.image_status.large, 'cached')
})

test('media retry is bounded: exponential backoff then a 30-day cooldown', async () => {
  const store = new MemoryR2()
  const db = new MemoryD1()
  const refresh = createSubjectMediaRefresh({
    db,
    store,
    fetchImage: async () => new Response('bad', { status: 500 }),
  })
  const subjects = mediaSubjectsFromFetch(fetchInput(collection(120224, { common: COMMON_URL, large: LARGE_URL })))
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
  }
  try {
    // Retry delays grow 6h → 12h → 24h → 48h → 96h, so each run needs a later clock.
    const runAt = async (iso: string) => refresh.refresh(
      { ...createRunContext({ runId: `run-${iso}`, deadlineAt: Date.now() + 60_000 }), observedAt: iso },
      { subjects },
    )
    const attempts = [
      '2023-11-14T00:00:00.000Z',
      '2023-11-14T06:00:01.000Z',
      '2023-11-14T18:00:02.000Z',
      '2023-11-15T18:00:03.000Z',
      '2023-11-17T18:00:04.000Z',
    ]
    const results = []
    for (const iso of attempts) results.push(await runAt(iso))

    assert.deepEqual(results.map((result) => result.selected), [1, 1, 1, 1, 1])
    assert.equal(results.at(-1)?.failures[0]?.error_code, MEDIA_IMAGE_FAILED_EXHAUSTED)
    assert.ok(logs.some((line) => line.includes('"stage":"media_failed_exhausted"') && line.includes('"retry_limit":5')))

    // After exhaustion the subject is parked for 30 days: an immediate re-run selects nothing.
    const parked = await refresh.refresh(
      { ...createRunContext({ runId: 'run-parked', deadlineAt: Date.now() + 60_000 }), observedAt: '2023-11-22T18:00:06.000Z' },
      { subjects },
    )
    assert.equal(parked.selected, 0, 'exhausted retries must not run on every sync')
  } finally {
    console.log = originalLog
  }
})

test('mediaRetryDelaySeconds caps at seven days', () => {
  assert.equal(mediaRetryDelaySeconds(1), 6 * 3_600)
  assert.equal(mediaRetryDelaySeconds(2), 12 * 3_600)
  assert.equal(mediaRetryDelaySeconds(3), 24 * 3_600)
  assert.equal(mediaRetryDelaySeconds(10), 7 * 86_400)
})
