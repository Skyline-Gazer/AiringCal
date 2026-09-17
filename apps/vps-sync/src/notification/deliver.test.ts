import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunResult } from '../contracts.js'

type Deliver = typeof import('./deliver.js')

async function deliverApi(): Promise<Deliver> {
  try {
    return await import('./deliver.js')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('Feishu notification delivery is not implemented')
    }
    throw error
  }
}

function result(): RunResult {
  return {
    id: 'run-1',
    source: 'manual',
    mode: 'live',
    gitSha: 'a'.repeat(40),
    stage: 'finished',
    status: 'success',
    heartbeatAt: '2026-09-17T00:00:00.000Z',
    finishedAt: '2026-09-17T00:00:01.000Z',
    counts: { users: 1, collections: 2 },
    stageDurations: { publication: 3 },
    sanitizedError: null,
    components: {
      publication: 'success',
      backup: 'success',
      notification: 'not_attempted',
    },
    publication: { status: 'published', generation: 4, contentHash: 'b'.repeat(64) },
    notificationFailure: null,
  }
}

test('posts one signed Feishu message with the query token and official code response', async () => {
  const { deliverNotification, signFeishu } = await deliverApi()
  const calls: Array<{ url: string; init: RequestInit }> = []
  const response = new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 })
  const sent = await deliverNotification({
    webhookUrl: 'https://feishu.test/hook?existing=1',
    token: 'query-token',
    secret: 'signing-secret',
    timeoutMs: 100,
    now: () => 1_789_000_123_456,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! })
      return response
    },
  }, result())

  assert.equal(sent, 'sent')
  assert.equal(calls.length, 1)
  const request = calls[0]!
  const url = new URL(request.url)
  assert.equal(url.searchParams.get('existing'), '1')
  assert.equal(url.searchParams.get('key'), 'query-token')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.headers && new Headers(request.init.headers).get('content-type'), 'application/json')
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
  assert.equal(body.msg_type, 'text')
  assert.equal(body.timestamp, '1789000123')
  assert.equal(body.sign, signFeishu('1789000123', 'signing-secret'))
  assert.equal(typeof (body.content as Record<string, unknown>).text, 'string')
})

test('includes only the previous compact failure summary in the next successful message', async () => {
  const { deliverNotification } = await deliverApi()
  let bodyText = ''
  const outcome = await deliverNotification({
    webhookUrl: 'https://feishu.test/hook',
    fetch: async (_url, init) => {
      bodyText = String((JSON.parse(String(init?.body)) as { content: { text: string } }).content.text)
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    },
  }, {
    ...result(),
    previousNotificationFailure: {
      category: 'notification', code: 'NOTIFICATION_FAILED', stage: 'notification', attemptCount: 1,
    },
  })

  assert.equal(outcome, 'sent')
  assert.match(bodyText, /previous_failure=notification\/NOTIFICATION_FAILED\/notification/)
  assert.doesNotMatch(bodyText, /webhook|secret|token|postgres/i)
})

test('returns failed once for non-2xx, non-zero code, and invalid JSON responses', async (t) => {
  const { deliverNotification } = await deliverApi()
  for (const [name, response] of [
    ['non-2xx', new Response(JSON.stringify({ code: 0 }), { status: 503 })],
    ['non-zero code', new Response(JSON.stringify({ code: 999 }), { status: 200 })],
    ['invalid JSON', new Response('{', { status: 200 })],
  ] as const) {
    await t.test(name, async () => {
      let calls = 0
      const outcome = await deliverNotification({
        webhookUrl: 'https://feishu.test/hook',
        timeoutMs: 100,
        fetch: async () => { calls++; return response },
      }, result())
      assert.equal(outcome, 'failed')
      assert.equal(calls, 1)
    })
  }
})

test('bounds a hanging request and aborts it without retrying', async () => {
  const { deliverNotification } = await deliverApi()
  let calls = 0
  let aborted = false
  const started = Date.now()
  const outcome = await deliverNotification({
    webhookUrl: 'https://feishu.test/hook',
    timeoutMs: 10,
    fetch: async (_url, init) => {
      calls++
      init?.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      return await new Promise<Response>(() => {})
    },
  }, result())

  assert.equal(outcome, 'failed')
  assert.equal(calls, 1)
  assert.equal(aborted, true)
  assert.ok(Date.now() - started < 500)
})

test('bounds a hanging response body as well as the request', async () => {
  const { deliverNotification } = await deliverApi()
  let aborted = false
  const outcome = await deliverNotification({
    webhookUrl: 'https://feishu.test/hook',
    timeoutMs: 10,
    fetch: async (_url, init) => {
      init?.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      return {
        status: 200,
        json: async () => await new Promise<unknown>(() => {}),
      } as Response
    },
  }, result())

  assert.equal(outcome, 'failed')
  assert.equal(aborted, true)
})

test('logs stable failure codes without transport credentials or raw errors', async () => {
  const { deliverNotification } = await deliverApi()
  const logs: unknown[] = []
  const secrets = [
    'https://feishu.test/hook?key=query-token',
    'query-token',
    'signing-secret',
    'postgresql://db-user:db-password@db.test/db',
    'raw upstream response',
  ]
  const outcome = await deliverNotification({
    webhookUrl: secrets[0]!,
    token: secrets[1],
    secret: secrets[2],
    timeoutMs: 100,
    fetch: async () => { throw new Error(`${secrets[3]} ${secrets[4]}`) },
    logger: (entry) => logs.push(entry),
  }, result())

  assert.equal(outcome, 'failed')
  assert.ok(logs.length > 0)
  for (const secret of secrets) assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
