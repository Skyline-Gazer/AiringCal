import assert from 'node:assert/strict'
import test from 'node:test'
import { notifyBarkFailure, readBarkConfig } from './bark.ts'

test('readBarkConfig returns null when unset', () => {
  assert.equal(readBarkConfig({}), null)
  assert.equal(readBarkConfig({ BARK_URL: '   ' }), null)
})

test('readBarkConfig trims BARK_URL', () => {
  assert.deepEqual(readBarkConfig({ BARK_URL: ' https://api.day.app/key ' }), {
    url: 'https://api.day.app/key',
  })
})

test('notifyBarkFailure no-ops when Bark is unset', async () => {
  const calls: string[] = []
  await notifyBarkFailure(
    {},
    { title: 'fail', body: 'x' },
    {
      fetch: async (url) => {
        calls.push(String(url))
        return new Response('ok')
      },
    },
  )
  assert.deepEqual(calls, [])
})

test('notifyBarkFailure POSTs JSON to BARK_URL', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  await notifyBarkFailure(
    { BARK_URL: 'https://api.day.app/PLACEHOLDER_BARK_KEY' },
    { title: 'AiringCal writer failed', body: 'portable sync=failed' },
    {
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response('ok', { status: 200 })
      },
    },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.day.app/PLACEHOLDER_BARK_KEY')
  assert.equal(calls[0].init.method, 'POST')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    title: 'AiringCal writer failed',
    body: 'portable sync=failed',
  })
})

test('notifyBarkFailure surfaces non-2xx as error', async () => {
  await assert.rejects(
    () =>
      notifyBarkFailure(
        { BARK_URL: 'https://api.day.app/key' },
        { title: 't', body: 'b' },
        { fetch: async () => new Response('nope', { status: 500 }) },
      ),
    /Bark notify failed: 500/,
  )
})
