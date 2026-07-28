import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalJson,
  imageOriginalKey,
  nextSubjectRefreshAt,
  sha256Canonical,
  type D1DatabaseLike,
  type D1MetaLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
  type MediaRefreshJobV3,
  type SubjectMediaRow,
} from '@airing-cal/storage'

const SUBJECT_MEDIA_COLUMNS = [
  'subject_id',
  'detail_json',
  'detail_hash',
  'media_hash',
  'nsfw',
  'source_image_common_url',
  'source_image_large_url',
  'r2_image_common_key',
  'r2_image_large_key',
  'checked_at',
  'next_refresh_at',
  'retry_count',
  'retry_after',
  'error_code',
] as const

const result = (changes: number): D1ResultLike => ({
  results: [],
  success: true,
  meta: {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: 0,
    changed_db: changes > 0,
    changes,
  } satisfies D1MetaLike,
})

class RecordingStatement implements D1PreparedStatementLike {
  values: unknown[] = []

  constructor(
    readonly database: RecordingD1,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values
    return this
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (!this.query.includes('FROM subject_media')) throw new Error(`Unexpected D1 first: ${this.query}`)
    if (this.database.row?.subject_id !== this.values[0]) return null
    return structuredClone(this.database.row) as T
  }

  async run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    throw new Error(`Unexpected D1 run: ${this.query}`)
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    throw new Error(`Unexpected D1 all: ${this.query}`)
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    throw new Error(`Unexpected D1 raw: ${this.query}`)
  }
}

class RecordingD1 implements D1DatabaseLike {
  batchCalls: RecordingStatement[][] = []

  constructor(public row?: SubjectMediaRow) {}

  prepare(query: string): D1PreparedStatementLike {
    return new RecordingStatement(this, query)
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const recorded = statements as RecordingStatement[]
    this.batchCalls.push(recorded)
    return recorded.map((statement) => {
      if (!statement.query.startsWith('INSERT INTO subject_media')) {
        throw new Error(`Unexpected D1 batch statement: ${statement.query}`)
      }
      const next = Object.fromEntries(
        SUBJECT_MEDIA_COLUMNS.map((column, index) => [column, statement.values[index]]),
      ) as unknown as SubjectMediaRow
      const changed = this.row === undefined
        || SUBJECT_MEDIA_COLUMNS.some((column) => this.row?.[column] !== next[column])
      if (changed) this.row = structuredClone(next)
      return result(changed ? 1 : 0) as D1ResultLike<T>
    })
  }

  async exec(): Promise<{ count: number; duration: number }> {
    return { count: 0, duration: 0 }
  }
}

class RecordingR2 {
  writes: Array<{ key: string; value: ArrayBuffer; options: unknown }> = []

  async get() {
    return null
  }

  async put(key: string, value: ArrayBuffer, options: unknown) {
    this.writes.push({ key, value, options })
    return {}
  }
}

const subject = (
  common = 'https://img.example/common.jpg',
  large = 'https://img.example/large.jpg',
) => ({
  id: 23080,
  type: 2,
  name: 'A',
  name_cn: 'A CN',
  summary: 'Summary',
  date: '2026-01-01',
  eps: 12,
  total_episodes: 12,
  nsfw: false,
  images: { common, large },
})

async function mediaHash(row: Pick<
  SubjectMediaRow,
  | 'nsfw'
  | 'source_image_common_url'
  | 'source_image_large_url'
  | 'r2_image_common_key'
  | 'r2_image_large_key'
>): Promise<string> {
  return sha256Canonical({
    nsfw: row.nsfw,
    source_image_common_url: row.source_image_common_url,
    source_image_large_url: row.source_image_large_url,
    r2_image_common_key: row.r2_image_common_key,
    r2_image_large_key: row.r2_image_large_key,
  })
}

async function existingRow(
  detail = subject(),
  overrides: Partial<SubjectMediaRow> = {},
): Promise<SubjectMediaRow> {
  const row: SubjectMediaRow = {
    subject_id: detail.id,
    detail_json: canonicalJson(detail),
    detail_hash: await sha256Canonical(detail),
    media_hash: null,
    nsfw: detail.nsfw ? 1 : 0,
    source_image_common_url: detail.images.common,
    source_image_large_url: detail.images.large,
    r2_image_common_key: imageOriginalKey('a'.repeat(64)),
    r2_image_large_key: imageOriginalKey('b'.repeat(64)),
    checked_at: 1_782_650_000,
    next_refresh_at: 1_783_250_000,
    retry_count: 0,
    retry_after: null,
    error_code: null,
    ...overrides,
  }
  row.media_hash = overrides.media_hash ?? await mediaHash(row)
  return row
}

const job: MediaRefreshJobV3 = {
  version: 3,
  generation: 7,
  job_id: 'd1-run:23080',
  subject_id: 23080,
  title: 'A CN',
  components: ['detail', 'meta', 'image_common', 'image_large'],
  images: {
    common: 'https://calendar.example/stale-common.jpg',
    large: 'https://calendar.example/stale-large.jpg',
  },
}

async function loadRefreshSubjectMediaD1() {
  const modulePath = './d1-media-state.ts'
  const loaded = await import(modulePath).catch(() => null)
  assert.ok(loaded, 'd1-media-state module should exist')
  assert.equal(typeof loaded.refreshSubjectMediaD1, 'function')
  return loaded.refreshSubjectMediaD1 as (
    env: { AIRING_CAL_D1: D1DatabaseLike; AIRING_CAL_R2: RecordingR2 },
    refreshJob: MediaRefreshJobV3,
  ) => Promise<{ d1Writes: number; imageWrites: number; status: string }>
}

test('identical canonical detail, media sources, and R2 refs perform exactly zero writes', async () => {
  const previous = await existingRow()
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/v0/subjects/23080')) return Response.json(subject())
    throw new Error(`unchanged media must not fetch images: ${url}`)
  }

  try {
    assert.deepEqual(
      await refreshSubjectMediaD1({ AIRING_CAL_D1: database, AIRING_CAL_R2: r2 }, job),
      { d1Writes: 0, imageWrites: 0, status: 'unchanged' },
    )
    assert.equal(database.batchCalls.length, 0)
    assert.equal(r2.writes.length, 0)
    assert.deepEqual(database.row, previous)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('matching sources and refs repair a stale authoritative media hash', async () => {
  const previous = await existingRow(subject(), { media_hash: 'stale' })
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/v0/subjects/23080')) return Response.json(subject())
    throw new Error(`stale hash repair must not fetch images: ${input}`)
  }

  try {
    assert.deepEqual(
      await refreshSubjectMediaD1({ AIRING_CAL_D1: database, AIRING_CAL_R2: r2 }, job),
      { d1Writes: 1, imageWrites: 0, status: 'updated' },
    )
    assert.equal(database.row?.media_hash, await mediaHash(database.row!))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a changed common image writes only its binary and one D1 subject row', async () => {
  const previous = await existingRow()
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const now = 1_782_700_000
  const next = subject('https://img.example/common-v2.jpg')
  const commonBytes = new TextEncoder().encode('new common image').buffer
  const commonHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', commonBytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/v0/subjects/23080')) return Response.json(next)
    if (url === next.images.common) {
      return new Response(commonBytes, { headers: { 'Content-Type': 'image/webp' } })
    }
    throw new Error(`large image must be preserved without download: ${url}`)
  }
  Date.now = () => now * 1000

  try {
    assert.deepEqual(
      await refreshSubjectMediaD1({ AIRING_CAL_D1: database, AIRING_CAL_R2: r2 }, job),
      { d1Writes: 1, imageWrites: 1, status: 'updated' },
    )
    assert.equal(database.batchCalls.length, 1)
    assert.equal(r2.writes.length, 1)
    assert.equal(r2.writes[0]?.key, imageOriginalKey(commonHash))
    assert.equal(database.row?.detail_json, canonicalJson(next))
    assert.equal(database.row?.detail_hash, await sha256Canonical(next))
    assert.equal(database.row?.source_image_common_url, next.images.common)
    assert.equal(database.row?.r2_image_common_key, imageOriginalKey(commonHash))
    assert.equal(database.row?.source_image_large_url, previous.source_image_large_url)
    assert.equal(database.row?.r2_image_large_key, previous.r2_image_large_key)
    assert.equal(database.row?.checked_at, now)
    assert.equal(database.row?.next_refresh_at, nextSubjectRefreshAt(job.subject_id, now))
    assert.equal(database.row?.retry_count, 0)
    assert.equal(database.row?.retry_after, null)
    assert.equal(database.row?.error_code, null)
    assert.equal(database.row?.media_hash, await mediaHash(database.row!))
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('a requested changed image 404 preserves its prior source-key pair and schedules retry only', async () => {
  const previous = await existingRow()
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const now = 1_782_750_000
  const next = subject('https://img.example/common-missing.jpg')
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/v0/subjects/23080')) return Response.json(next)
    if (url === next.images.common) return new Response('private image error body', { status: 404 })
    throw new Error(`unexpected fetch ${url}`)
  }
  Date.now = () => now * 1000

  try {
    assert.deepEqual(
      await refreshSubjectMediaD1(
        { AIRING_CAL_D1: database, AIRING_CAL_R2: r2 },
        { ...job, components: ['detail', 'meta', 'image_common'] },
      ),
      { d1Writes: 1, imageWrites: 0, status: 'retry_scheduled' },
    )
    assert.deepEqual(database.row, {
      ...previous,
      retry_count: 1,
      retry_after: now + 30,
      error_code: 'IMAGE_UNAVAILABLE',
    })
    assert.equal(database.row?.source_image_common_url, previous.source_image_common_url)
    assert.equal(database.row?.r2_image_common_key, previous.r2_image_common_key)
    assert.equal(r2.writes.length, 0)
    assert.doesNotMatch(JSON.stringify(database.row), /private image error body/)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('a requested image source that vanishes preserves its prior source-key pair and schedules retry', async () => {
  const previous = await existingRow()
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const now = 1_782_760_000
  const next = {
    ...subject(),
    images: { large: 'https://img.example/large.jpg' },
  }
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/v0/subjects/23080')) return Response.json(next)
    throw new Error(`vanished source must not download or mutate its pair: ${input}`)
  }
  Date.now = () => now * 1000

  try {
    assert.deepEqual(
      await refreshSubjectMediaD1(
        { AIRING_CAL_D1: database, AIRING_CAL_R2: r2 },
        { ...job, components: ['detail', 'meta', 'image_common'] },
      ),
      { d1Writes: 1, imageWrites: 0, status: 'retry_scheduled' },
    )
    assert.deepEqual(database.row, {
      ...previous,
      retry_count: 1,
      retry_after: now + 30,
      error_code: 'IMAGE_UNAVAILABLE',
    })
    assert.equal(database.row?.source_image_common_url, previous.source_image_common_url)
    assert.equal(database.row?.r2_image_common_key, previous.r2_image_common_key)
    assert.equal(r2.writes.length, 0)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('a subject tombstone preserves both existing source-key pairs without retrying or deleting bytes', async () => {
  const previous = await existingRow()
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const now = 1_782_770_000
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/v0/subjects/23080')) return new Response('not found', { status: 404 })
    throw new Error(`subject tombstone must not fetch or delete images: ${input}`)
  }
  Date.now = () => now * 1000

  const expected: SubjectMediaRow = {
    ...previous,
    detail_json: null,
    detail_hash: null,
    media_hash: null,
    nsfw: 1,
    checked_at: now,
    next_refresh_at: nextSubjectRefreshAt(job.subject_id, now),
    retry_count: 0,
    retry_after: null,
    error_code: null,
  }
  expected.media_hash = await mediaHash(expected)

  try {
    assert.deepEqual(
      await refreshSubjectMediaD1({ AIRING_CAL_D1: database, AIRING_CAL_R2: r2 }, job),
      { d1Writes: 1, imageWrites: 0, status: 'updated' },
    )
    assert.deepEqual(database.row, expected)
    assert.equal(database.row?.source_image_common_url, previous.source_image_common_url)
    assert.equal(database.row?.r2_image_common_key, previous.r2_image_common_key)
    assert.equal(database.row?.source_image_large_url, previous.source_image_large_url)
    assert.equal(database.row?.r2_image_large_key, previous.r2_image_large_key)
    assert.equal(r2.writes.length, 0)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('a transient upstream error changes only classified retry fields and never persists its body', async () => {
  const previous = await existingRow()
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const now = 1_782_800_000
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  globalThis.fetch = async () => new Response('TOP_SECRET_UPSTREAM_BODY', {
    status: 429,
    headers: { 'Retry-After': '0' },
  })
  Date.now = () => now * 1000

  try {
    assert.deepEqual(
      await refreshSubjectMediaD1({ AIRING_CAL_D1: database, AIRING_CAL_R2: r2 }, job),
      { d1Writes: 1, imageWrites: 0, status: 'retry_scheduled' },
    )
    assert.equal(database.batchCalls.length, 1)
    assert.equal(r2.writes.length, 0)
    assert.deepEqual(database.row, {
      ...previous,
      retry_count: 1,
      retry_after: now + 30,
      error_code: 'BGM_RATE_LIMITED',
    })
    assert.doesNotMatch(JSON.stringify(database.row), /TOP_SECRET_UPSTREAM_BODY/)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})

test('an unrequested changed image keeps its previous source and R2 key paired for future planning', async () => {
  const previous = await existingRow()
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const next = subject(
    'https://img.example/common-v3.jpg',
    'https://img.example/large-v3.jpg',
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/v0/subjects/23080')) return Response.json(next)
    if (url === next.images.common) return new Response('new common only')
    throw new Error(`unrequested large image must remain pending: ${url}`)
  }

  try {
    const result = await refreshSubjectMediaD1(
      { AIRING_CAL_D1: database, AIRING_CAL_R2: r2 },
      { ...job, components: ['detail', 'meta', 'image_common'] },
    )
    assert.deepEqual(result, { d1Writes: 1, imageWrites: 1, status: 'updated' })
    assert.equal(database.row?.source_image_common_url, next.images.common)
    assert.notEqual(database.row?.r2_image_common_key, previous.r2_image_common_key)
    assert.equal(database.row?.source_image_large_url, previous.source_image_large_url)
    assert.equal(database.row?.r2_image_large_key, previous.r2_image_large_key)
    assert.equal(JSON.parse(database.row?.detail_json ?? '{}').images.large, next.images.large)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a terminal auth error clears earlier transient retry scheduling', async () => {
  const previous = await existingRow()
  const database = new RecordingD1(previous)
  const r2 = new RecordingR2()
  const refreshSubjectMediaD1 = await loadRefreshSubjectMediaD1()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('retry', {
    status: 429,
    headers: { 'Retry-After': '0' },
  })

  try {
    assert.equal(
      (await refreshSubjectMediaD1({ AIRING_CAL_D1: database, AIRING_CAL_R2: r2 }, job)).status,
      'retry_scheduled',
    )
    assert.equal(database.row?.retry_count, 1)

    globalThis.fetch = async () => new Response('private upstream body', { status: 401 })
    assert.equal(
      (await refreshSubjectMediaD1({ AIRING_CAL_D1: database, AIRING_CAL_R2: r2 }, job)).status,
      'updated',
    )
    assert.equal(database.row?.retry_count, 0)
    assert.equal(database.row?.retry_after, null)
    assert.equal(database.row?.error_code, 'BGM_UNAUTHORIZED')
    assert.doesNotMatch(JSON.stringify(database.row), /private upstream body/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
