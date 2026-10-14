import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeThumbGenConfig,
  fireAndForgetThumbGen,
  logThumbGenSyncTail,
  postThumbGenBatch,
  resolveThumbGenConfig,
} from './thumb-gen-client.ts'

test('resolveThumbGenConfig prefers explicit URL', () => {
  assert.deepEqual(
    resolveThumbGenConfig({
      AIRINGCAL_THUMB_GEN_URL: 'https://site.example/api/thumb-gen',
      AIRINGCAL_THUMB_GEN_BEARER: 'token',
    }),
    { url: 'https://site.example/api/thumb-gen', bearer: 'token' },
  )
})

test('describeThumbGenConfig reports missing bearer when URL set', () => {
  assert.deepEqual(
    describeThumbGenConfig({ AIRINGCAL_THUMB_GEN_URL: 'https://site.example/api/thumb-gen' }),
    { state: 'missing_bearer', url_present: true, bearer_present: false },
  )
})

test('logThumbGenSyncTail warns when new larges but env incomplete', () => {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    logs.push(String(args[0]))
  }
  try {
    logThumbGenSyncTail({
      env: { AIRINGCAL_THUMB_GEN_URL: 'https://x/api/thumb-gen' },
      large_persisted_this_run: 2,
      account_large_count: 10,
    })
    const line = logs.find((entry) => entry.includes('thumb_gen_tail'))
    assert.ok(line)
    assert.match(line!, /"status":"warn"/)
    assert.match(line!, /missing_bearer/)
  } finally {
    console.log = original
  }
})

test('logThumbGenSyncTail info when no new large but account has larges', () => {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    logs.push(String(args[0]))
  }
  try {
    logThumbGenSyncTail({
      env: {
        AIRINGCAL_THUMB_GEN_URL: 'https://x/api/thumb-gen',
        AIRINGCAL_THUMB_GEN_BEARER: 'secret',
      },
      large_persisted_this_run: 0,
      account_large_count: 5,
    })
    const line = logs.find((entry) => entry.includes('thumb_gen_tail'))
    assert.ok(line)
    assert.match(line!, /"status":"info"/)
    assert.match(line!, /cron/)
  } finally {
    console.log = original
  }
})

test('resolveThumbGenConfig derives URL from web origin', () => {
  assert.deepEqual(
    resolveThumbGenConfig({
      AIRINGCAL_WEB_ORIGIN: 'https://site.example/',
      AIRINGCAL_THUMB_GEN_BEARER: 'token',
    }),
    { url: 'https://site.example/api/thumb-gen', bearer: 'token' },
  )
})

test('postThumbGenBatch sends bearer and large_hashes', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit = {}
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedInit = init ?? {}
    return new Response('{"ok":true}', { status: 202 })
  }
  const result = await postThumbGenBatch(['a'.repeat(64)], { url: 'https://x/api/thumb-gen', bearer: 'secret' }, fetchImpl as typeof fetch)
  assert.equal(result.status, 202)
  assert.equal(capturedUrl, 'https://x/api/thumb-gen')
  assert.equal((capturedInit.headers as Record<string, string>).Authorization, 'Bearer secret')
  assert.match(String(capturedInit.body), /large_hashes/)
})

test('fireAndForgetThumbGen logs errors without throwing', async () => {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    logs.push(String(args[0]))
  }
  try {
    fireAndForgetThumbGen(
      ['b'.repeat(64)],
      { AIRINGCAL_THUMB_GEN_URL: 'https://x/api/thumb-gen', AIRINGCAL_THUMB_GEN_BEARER: 'secret' },
      async () => {
        throw new Error('network down')
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(logs.some((line) => line.includes('thumb_gen_trigger') && line.includes('error')))
  } finally {
    console.log = original
  }
})
