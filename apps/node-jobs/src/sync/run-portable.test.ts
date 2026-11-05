import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryPublicStore, PUBLIC_RELEASE_POINTER_KEY, type PublicStore } from '@airing-cal/v3-core'
import test from 'node:test'
import { assembleFullFetch, type BgmCollection } from '@airing-cal/bgm-api'
import sharp from 'sharp'
import { imageOriginalKey, imageThumbV2Key } from '@airing-cal/storage'
import { runPortableBuilderSync } from './run-portable.ts'

const COMMON_URL = 'https://lain.bgm.tv/pic/cover/c/common.jpg'
const LARGE_URL = 'https://lain.bgm.tv/pic/cover/l/large.jpg'

const gitSha = 'c'.repeat(40)

function baseEnv(sqlitePath: string): Record<string, string> {
  return {
    AIRINGCAL_BUILDER: 'portable',
    AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
    AIRINGCAL_USERS_JSON: JSON.stringify([{ userId: '1', username: 'tester' }]),
    AIRINGCAL_PRIMARY_USER_ID: '1',
    BANGUMI_GIT_COMMIT_SHA: gitSha,
  }
}

function emptyFetch() {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('runSync portable path skips without AIRINGCAL_USERS_JSON', async () => {
  const summary = await runPortableBuilderSync({ AIRINGCAL_BUILDER: 'portable' })
  assert.equal(summary.status, 'skipped')
})

test('runPortableBuilderSync checkpoints snapshot in SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-builder-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const summary = await runPortableBuilderSync(baseEnv(sqlitePath), {
    fetchInput: async () => emptyFetch(),
  })
  assert.equal(summary.status, 'success')
  assert.match(summary.message, /sync=ok/)
  assert.match(summary.message, /media=skip/)
})

function collectionEntry(subjectId: number): BgmCollection {
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
    private: false,
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
      images: { large: LARGE_URL, common: COMMON_URL, medium: COMMON_URL, small: COMMON_URL, grid: COMMON_URL },
      rating: { score: 7, rank: 100, total: 10 },
    },
  }
}

function collectionFetch(subjectId: number): ReturnType<typeof assembleFullFetch> {
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 1, data: [collectionEntry(subjectId)] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
}

test('runPortableBuilderSync fails when MEDIA_REFRESH=refresh without image root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-builder-media-'))
  const summary = await runPortableBuilderSync(
    { ...baseEnv(join(dir, 'builder.sqlite')), AIRINGCAL_BUILDER_MEDIA_REFRESH: 'refresh' },
    { fetchInput: async () => emptyFetch() },
  )
  assert.equal(summary.status, 'failed')
  assert.match(summary.message, /AIRINGCAL_BUILDER_PUBLIC_DIR|AIRINGCAL_BUILDER_IMAGE_DIR/)
})

test('runPortableBuilderSync downloads media to filesystem when MEDIA_REFRESH=refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-builder-media-'))
  const imageRoot = join(dir, 'public-store')
  const summary = await runPortableBuilderSync(
    {
      ...baseEnv(join(dir, 'builder.sqlite')),
      AIRINGCAL_BUILDER_MEDIA_REFRESH: 'refresh',
      AIRINGCAL_BUILDER_PUBLIC_DIR: imageRoot,
    },
    {
      fetchInput: async () => collectionFetch(42),
      fetchImage: async () => {
        const body = await sharp({
          create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
        }).jpeg().toBuffer()
        return new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
      },
    },
  )
  assert.equal(summary.status, 'success')
  assert.match(summary.message, /media=refresh selected=1 succeeded=1/)
})

test('runPortableBuilderSync publishes durable release when PUBLIC_DIR set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-builder-pub-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const publicDir = join(dir, 'public-store')
  const summary = await runPortableBuilderSync(
    {
      ...baseEnv(sqlitePath),
      AIRINGCAL_BUILDER_PUBLISH: 'true',
      AIRINGCAL_BUILDER_PUBLIC_DIR: publicDir,
    },
    { fetchInput: async () => emptyFetch() },
  )
  assert.equal(summary.status, 'success')
  assert.match(summary.message, /publish=published|publish=already_current/)
  readFileSync(join(publicDir, PUBLIC_RELEASE_POINTER_KEY), 'utf8')
})

test('runSync is portable-only; legacy-d1 is rejected (ADR 0003)', async () => {
  const { runSync, resolveSyncBuilderKind } = await import('./run.ts')
  assert.equal(resolveSyncBuilderKind({}), 'portable')
  assert.equal(resolveSyncBuilderKind({ AIRINGCAL_BUILDER: 'legacy-d1' }), 'rejected')
  const rejected = await runSync({ AIRINGCAL_BUILDER: 'legacy-d1' })
  assert.equal(rejected.status, 'failed')
  assert.match(rejected.message, /legacy-d1|retired|ADR 0003/i)
  const summary = await runSync({
    AIRINGCAL_USERS_JSON: JSON.stringify([{ userId: '1', username: 'x' }]),
    AIRINGCAL_PRIMARY_USER_ID: '1',
    BANGUMI_GIT_COMMIT_SHA: 'a'.repeat(40),
  })
  assert.equal(summary.status, 'failed')
  assert.match(summary.message, /AIRINGCAL_BUILDER_SQLITE_PATH/)
})

function varyingFetchImage() {
  let n = 0
  return async () => {
    n += 1
    const body = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: n % 255, g: 2, b: 3 } },
    }).jpeg().toBuffer()
    return new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
  }
}

class CountingPublicStore implements PublicStore {
  puts: string[] = []
  constructor(private readonly inner: MemoryPublicStore) {}
  async getCurrentRelease() {
    return this.inner.getCurrentRelease()
  }
  async getSnapshotBytes(ref: string) {
    return this.inner.getSnapshotBytes(ref)
  }
  async putImmutableObject(key: string, body: Uint8Array, contentType: string) {
    this.puts.push(key)
    return this.inner.putImmutableObject(key, body, contentType)
  }
  async commitRelease(
    expected: Parameters<PublicStore['commitRelease']>[0],
    next: Parameters<PublicStore['commitRelease']>[1],
  ) {
    return this.inner.commitRelease(expected, next)
  }
}

function refreshEnv(sqlitePath: string, imageDir: string): Record<string, string> {
  return {
    ...baseEnv(sqlitePath),
    AIRINGCAL_BUILDER_PUBLISH: 'true',
    AIRINGCAL_BUILDER_MEDIA_REFRESH: 'refresh',
    AIRINGCAL_BUILDER_IMAGE_DIR: imageDir,
  }
}

test('publish gate fails closed and pointer never advances when a referenced image is missing everywhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-missing-'))
  const store = new MemoryPublicStore()
  try {
    const first = await runPortableBuilderSync(refreshEnv(join(dir, 'builder.sqlite'), join(dir, 'images')), {
      fetchInput: async () => collectionFetch(42),
      fetchImage: varyingFetchImage(),
      publicStore: store,
    })
    assert.equal(first.status, 'success')
    assert.match(first.message, /publish=published/)
    const hash = readdirSync(join(dir, 'images', 'images'))[0]!
    assert.ok(hash)

    // Drop the pointer and the referenced image objects everywhere: a no_change republish must fail closed.
    store.current = null
    store.objects.delete(imageOriginalKey(hash))
    store.objects.delete(imageThumbV2Key(hash))
    rmSync(join(dir, 'images', 'images', hash, 'original'))
    rmSync(join(dir, 'images', 'images', hash, 'thumb.v2.webp'), { force: true })
    const second = await runPortableBuilderSync(refreshEnv(join(dir, 'builder.sqlite'), join(dir, 'images')), {
      fetchInput: async () => collectionFetch(42),
      fetchImage: varyingFetchImage(),
      publicStore: store,
    })
    assert.equal(second.status, 'failed')
    assert.match(second.message, /publish=pre_publish_failed/)
    assert.equal(store.current, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no_change republish succeeds when public image objects are complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-reuse-'))
  const store = new MemoryPublicStore()
  try {
    const first = await runPortableBuilderSync(refreshEnv(join(dir, 'builder.sqlite'), join(dir, 'images')), {
      fetchInput: async () => collectionFetch(42),
      fetchImage: varyingFetchImage(),
      publicStore: store,
    })
    assert.equal(first.status, 'success')
    const firstRef = store.current!.manifest_ref

    // Lose the pointer, keep the public objects: republish must recover without local files.
    store.current = null
    const second = await runPortableBuilderSync(refreshEnv(join(dir, 'builder.sqlite'), join(dir, 'images')), {
      fetchInput: async () => collectionFetch(42),
      fetchImage: varyingFetchImage(),
      publicStore: store,
    })
    assert.equal(second.status, 'success')
    assert.match(second.message, /publish=published/)
    assert.equal(store.current!.manifest_ref, firstRef)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('incremental publish reuses prior public objects and uploads only new images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-gate-incr-'))
  const inner = new MemoryPublicStore()
  const store = new CountingPublicStore(inner)
  try {
    const first = await runPortableBuilderSync(refreshEnv(join(dir, 'builder.sqlite'), join(dir, 'images')), {
      fetchInput: async () => collectionFetch(42),
      fetchImage: varyingFetchImage(),
      publicStore: store,
    })
    assert.equal(first.status, 'success')
    store.puts.length = 0

    const twoSubjects = assembleFullFetch(
      [
        { user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 2, data: [collectionEntry(42), collectionEntry(43)] }] },
      ],
      [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
      1_700_000_000,
    )
    const second = await runPortableBuilderSync(refreshEnv(join(dir, 'builder.sqlite'), join(dir, 'images')), {
      fetchInput: async () => twoSubjects,
      fetchImage: varyingFetchImage(),
      publicStore: store,
    })
    assert.equal(second.status, 'success')
    assert.match(second.message, /publish=published/)
    assert.equal(inner.current!.generation, 2)
    const firstHash = readdirSync(join(dir, 'images', 'images'))[0]!
    assert.ok(inner.getSnapshotBytes(imageOriginalKey(firstHash)))
    assert.deepEqual(
      store.puts.filter((key) => key.startsWith(`images/${firstHash}/`)),
      [],
      'prior generation images must be reused without re-upload',
    )
    assert.ok(store.puts.some((key) => key === imageThumbV2Key(firstHash)) === false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
