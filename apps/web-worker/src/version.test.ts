import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'
import { buildVersionPayload, WEB_WORKER_PACKAGE } from './version.ts'

test('buildVersionPayload normalizes git commit and short sha', () => {
  const payload = buildVersionPayload({
    BANGUMI_GIT_COMMIT_SHA: '4C540BCD9FD494563CF4503338B5EFC6DB28E3AF',
    BANGUMI_GIT_REPOSITORY_URL: 'https://github.com/Skyline-Gazer/AiringCal',
    BANGUMI_BUILD_TIME: '2026-10-10T10:20:55Z',
  })
  assert.equal(payload.git.commit, '4c540bcd9fd494563cf4503338b5efc6db28e3af')
  assert.equal(payload.git.commit_short, '4c540bc')
  assert.equal(payload.build.built_at, '2026-10-10T10:20:55Z')
  assert.equal(payload.package.version, WEB_WORKER_PACKAGE.version)
})

test('GET /api/version returns build metadata JSON', async () => {
  const response = await worker.fetch(new Request('https://airingcal.example/api/version'), {
    BANGUMI_GIT_COMMIT_SHA: '4c540bcd9fd494563cf4503338b5efc6db28e3af',
    BANGUMI_GIT_REPOSITORY_URL: 'https://github.com/Skyline-Gazer/AiringCal',
    BANGUMI_BUILD_TIME: '2026-10-10T10:20:55Z',
  } as never)
  assert.ok(response)
  assert.equal(response!.status, 200)
  const body = await response!.json() as { git: { commit_short: string } }
  assert.equal(body.git.commit_short, '4c540bc')
})
