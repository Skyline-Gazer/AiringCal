import assert from 'node:assert/strict'
import test from 'node:test'
import { deliverNotification, type DeliveryClock } from './deliver.ts'
import type { RunResult } from '../contracts.ts'

const result: RunResult = {
  id: 'run-1', source: 'manual', mode: 'shadow', stage: 'finished', status: 'success', gitSha: 'a'.repeat(40),
  heartbeatAt: '2026-09-10T00:00:00.000Z', finishedAt: '2026-09-10T00:00:00.000Z',
  counts: {}, stageDurations: {}, sanitizedError: null,
  components: { publication: 'success', backup: 'success', notification: 'not_attempted' },
}

function clock(): DeliveryClock {
  return { now: () => 1_599_360_473_000, setTimeout: () => 1, clearTimeout: () => undefined }
}

test('marks a bounded timeout as failed without exposing webhook credentials', async () => {
  let signal: AbortSignal | undefined
  const timedOutClock: DeliveryClock = {
    ...clock(),
    setTimeout: (callback) => { callback(); return 1 },
  }
  const outcome = await deliverNotification(
    { webhookUrl: 'https://open.feishu.cn/secret-webhook', secret: 'signature-secret', timeoutMs: 1 },
    result,
    undefined,
    { fetch: async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    }, clock: timedOutClock },
  )
  assert.equal(outcome, 'failed')
  assert.equal(signal?.aborted, true)
})

test('marks non-2xx and malformed successful responses as failed after one delivery attempt', async () => {
  for (const response of [
    new Response('{"code":0}', { status: 500 }),
    new Response('not json', { status: 200 }),
    new Response('{"code":1}', { status: 200 }),
  ]) {
    let attempts = 0
    const outcome = await deliverNotification(
      { webhookUrl: 'https://open.feishu.cn/webhook', timeoutMs: 1_000 },
      result,
      undefined,
      { fetch: async () => { attempts += 1; return response }, clock: clock() },
    )
    assert.equal(outcome, 'failed')
    assert.equal(attempts, 1)
  }
})

test('sends one signed sanitized payload and includes the compact previous failure summary', async () => {
  let url = ''
  let init: RequestInit | undefined
  const outcome = await deliverNotification(
    { webhookUrl: 'https://open.feishu.cn/webhook', secret: 'signature-secret', timeoutMs: 1_000 },
    result,
    { category: 'postgres://db-secret@example.test/app', code: 'token=top-secret', stage: 'notification' },
    { fetch: async (nextUrl, nextInit) => {
      url = String(nextUrl); init = nextInit
      return new Response('{"code":0}', { status: 200 })
    }, clock: clock() },
  )
  assert.equal(outcome, 'sent')
  assert.equal(url, 'https://open.feishu.cn/webhook')
  assert.equal(init?.method, 'POST')
  assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/json')
  assert.match((init?.headers as Record<string, string>).Timestamp, /^1599360473$/)
  assert.match((init?.headers as Record<string, string>).Sign, /^[A-Za-z0-9+/=]+$/)
  const body = String(init?.body)
  for (const secret of ['signature-secret', 'db-secret', 'top-secret', 'https://']) assert.doesNotMatch(body, new RegExp(secret))
  assert.match(body, /previous_failure=\[redacted\]/)
})
