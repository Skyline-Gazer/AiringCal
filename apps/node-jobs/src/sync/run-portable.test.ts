import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILESYSTEM_PUBLIC_POINTER_KEY } from '@airing-cal/v3-core'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { runPortableBuilderSync } from './run-portable.ts'

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

test('runPortableBuilderSync fails closed when MEDIA_REFRESH=refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-builder-media-'))
  const summary = await runPortableBuilderSync(
    { ...baseEnv(join(dir, 'builder.sqlite')), AIRINGCAL_BUILDER_MEDIA_REFRESH: 'refresh' },
    { fetchInput: async () => emptyFetch() },
  )
  assert.equal(summary.status, 'failed')
  assert.match(summary.message, /not implemented/)
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
  readFileSync(join(publicDir, FILESYSTEM_PUBLIC_POINTER_KEY), 'utf8')
})

test('legacy cloudflare path remains default when AIRINGCAL_BUILDER unset', async () => {
  const { runSync } = await import('./run.ts')
  const summary = await runSync({})
  assert.equal(summary.status, 'skipped')
  assert.match(summary.message, /AIRINGCAL_USERS_JSON/)
})
