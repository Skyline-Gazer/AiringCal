import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core'
import test from 'node:test'
import { assembleFullFetch, type BgmCollection } from '@airing-cal/bgm-api'
import sharp from 'sharp'
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

function collectionFetch(subjectId: number): ReturnType<typeof assembleFullFetch> {
  const entry: BgmCollection = {
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
  return assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 1, data: [entry] }] }],
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

test('legacy cloudflare path remains default when AIRINGCAL_BUILDER unset', async () => {
  const { runSync } = await import('./run.ts')
  const summary = await runSync({})
  assert.equal(summary.status, 'skipped')
  assert.match(summary.message, /AIRINGCAL_USERS_JSON/)
})
