import assert from 'node:assert/strict'
import test from 'node:test'
import { fireAndForgetThumbGen, postThumbGenBatch, resolveThumbGenConfig } from './thumb-gen-client.ts'

test('resolveThumbGenConfig prefers explicit URL', () => {
  assert.deepEqual(
    resolveThumbGenConfig({
      AIRINGCAL_THUMB_GEN_URL: 'https://site.example/api/thumb-gen',
      AIRINGCAL_THUMB_GEN_BEARER: 'token',
    }),
    { url: 'https://site.example/api/thumb-gen', bearer: 'token' },
  )
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
