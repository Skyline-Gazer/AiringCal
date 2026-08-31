import assert from 'node:assert/strict'
import test from 'node:test'
import { BgmHttpError, BgmNetworkError } from '@airing-cal/bgm-api'
import { UpstreamFetchError, withRetry } from './retry.ts'

test('withRetry retries a rate limit at most three times and caps a valid Retry-After delay', async () => {
  let attempts = 0
  const delays: number[] = []

  await assert.rejects(
    () => withRetry(
      async () => {
        attempts++
        throw new BgmHttpError(429, 'raw response body must not escape', { retryAfter: '120' })
      },
      {
        stage: 'collections',
        maxAttempts: 3,
        maxDelayMs: 1_000,
        sleep: async (delay) => { delays.push(delay) },
        random: () => 0.5,
        now: () => 0,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamFetchError)
      assert.deepEqual(
        { category: error.category, code: error.code, stage: error.stage, attempt: error.attempt },
        { category: 'rate_limited', code: 'UPSTREAM_RATE_LIMITED', stage: 'collections', attempt: 3 },
      )
      assert.doesNotMatch(error.message, /raw response|body|http/i)
      return true
    },
  )

  assert.equal(attempts, 3)
  assert.deepEqual(delays, [1_000, 1_000])
})

test('withRetry rejects policies that could exceed the three-attempt global limit before invoking the operation', async () => {
  let calls = 0
  await assert.rejects(
    () => withRetry(
      async () => {
        calls++
        return 'unexpected'
      },
      { stage: 'collections', maxAttempts: 4 },
    ),
    (error: unknown) => error instanceof UpstreamFetchError && error.code === 'INVALID_RETRY_POLICY' && error.attempt === 1,
  )
  assert.equal(calls, 0)
})

test('withRetry treats 401 and 403 as terminal authentication errors', async () => {
  for (const status of [401, 403]) {
    let attempts = 0
    await assert.rejects(
      () => withRetry(
        async () => {
          attempts++
          throw new BgmHttpError(status, 'token=secret')
        },
        { stage: 'calendar', sleep: async () => undefined },
      ),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamFetchError)
        assert.equal(error.category, 'auth')
        assert.equal(error.attempt, 1)
        assert.doesNotMatch(error.message, /secret/)
        return true
      },
    )
    assert.equal(attempts, 1)
  }
})

test('withRetry uses bounded exponential jitter when Retry-After is invalid', async () => {
  let attempts = 0
  const delays: number[] = []
  await assert.rejects(
    () => withRetry(
      async () => {
        attempts++
        throw new BgmNetworkError('dns failure')
      },
      {
        stage: 'calendar',
        baseDelayMs: 100,
        maxDelayMs: 150,
        random: () => 1,
        sleep: async (delay) => { delays.push(delay) },
      },
    ),
    UpstreamFetchError,
  )
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [150, 150])
})

test('withRetry ignores negative, fractional, and exponent Retry-After values', async () => {
  for (const retryAfter of ['-1', '1.5', '1e3']) {
    const delays: number[] = []
    let attempts = 0
    await assert.rejects(
      () => withRetry(
        async () => {
          attempts++
          throw new BgmHttpError(429, 'raw response', { retryAfter })
        },
        { stage: 'calendar', baseDelayMs: 100, maxDelayMs: 1_000, random: () => 0.5, sleep: async (delay) => { delays.push(delay) } },
      ),
      UpstreamFetchError,
    )
    assert.equal(attempts, 3)
    assert.deepEqual(delays, [100, 200])
  }
})

test('withRetry uses a valid HTTP-date Retry-After and falls back for invalid text', async () => {
  const retryAfterCases = [
    { retryAfter: new Date(5_000).toUTCString(), expectedDelays: [5_000, 5_000] },
    { retryAfter: 'not-a-date', expectedDelays: [100, 200] },
  ]
  for (const { retryAfter, expectedDelays } of retryAfterCases) {
    let attempts = 0
    const delays: number[] = []
    await assert.rejects(
      () => withRetry(
        async () => {
          attempts++
          throw new BgmHttpError(429, 'raw retry header must not escape', { retryAfter })
        },
        { stage: 'calendar', baseDelayMs: 100, maxDelayMs: 10_000, random: () => 0.5, now: () => 0, sleep: async (delay) => { delays.push(delay) } },
      ),
      UpstreamFetchError,
    )
    assert.equal(attempts, 3)
    assert.deepEqual(delays, expectedDelays)
  }
})
