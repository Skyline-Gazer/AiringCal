import assert from 'node:assert/strict'
import test from 'node:test'
import { BgmHttpError, BgmNetworkError, BgmTimeoutError } from '@airing-cal/bgm-api'
import { UpstreamFetchError, withRetry } from './retry.js'

function httpError(status: number, retryAfter?: string): BgmHttpError {
  const error = new BgmHttpError(status, 'secret URL and response body') as BgmHttpError & { retryAfter?: string }
  error.retryAfter = retryAfter
  return error
}

test('withRetry stops authentication failures after one attempt', async () => {
  for (const status of [401, 403]) {
    let attempts = 0
    await assert.rejects(
      () => withRetry(async () => {
        attempts++
        throw httpError(status)
      }, { stage: 'collections', sleep: async () => undefined }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamFetchError)
        assert.deepEqual({ category: error.category, code: error.code, stage: error.stage, attempt: error.attempt }, {
          category: 'auth',
          code: status === 401 ? 'UPSTREAM_UNAUTHORIZED' : 'UPSTREAM_FORBIDDEN',
          stage: 'collections',
          attempt: 1,
        })
        assert.doesNotMatch(error.message, /secret|URL|body/i)
        return true
      },
    )
    assert.equal(attempts, 1)
  }
})

test('withRetry caps Retry-After and makes at most three transient attempts', async () => {
  let attempts = 0
  const delays: number[] = []
  await assert.rejects(
    () => withRetry(async () => {
      attempts++
      throw httpError(429, '120')
    }, {
      stage: 'calendar',
      maxDelayMs: 1_000,
      sleep: async (delay) => { delays.push(delay) },
      now: () => 0,
    }),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamFetchError)
      assert.deepEqual({ category: error.category, code: error.code, stage: error.stage, attempt: error.attempt }, {
        category: 'rate_limited', code: 'UPSTREAM_RATE_LIMITED', stage: 'calendar', attempt: 3,
      })
      return true
    },
  )
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [1_000, 1_000])
})

test('withRetry retries 5xx, timeout, and network failures at most three times', async () => {
  for (const failure of [
    () => httpError(503),
    () => new BgmTimeoutError('secret timeout'),
    () => new BgmNetworkError('secret network failure'),
  ]) {
    let attempts = 0
    await assert.rejects(
      () => withRetry(async () => {
        attempts++
        throw failure()
      }, { stage: 'collections', baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamFetchError)
        assert.equal(error.attempt, 3)
        assert.doesNotMatch(error.message, /secret/i)
        return true
      },
    )
    assert.equal(attempts, 3)
  }
})

test('withRetry treats invalid JSON and schema failures as terminal contract errors', async () => {
  let attempts = 0
  await assert.rejects(
    () => withRetry(async () => {
      attempts++
      throw new SyntaxError('raw invalid JSON')
    }, { stage: 'collections', sleep: async () => undefined }),
    (error: unknown) => error instanceof UpstreamFetchError
      && error.category === 'contract'
      && error.code === 'UPSTREAM_CONTRACT'
      && error.attempt === 1,
  )
  assert.equal(attempts, 1)
})

test('withRetry rejects a policy above the global three-attempt limit', async () => {
  let attempts = 0
  await assert.rejects(
    () => withRetry(async () => {
      attempts++
      return 'unexpected'
    }, { stage: 'collections', maxAttempts: 4 }),
    (error: unknown) => error instanceof UpstreamFetchError
      && error.category === 'contract'
      && error.code === 'INVALID_RETRY_POLICY'
      && error.attempt === 1,
  )
  assert.equal(attempts, 0)
})

test('withRetry sanitizes delay, clock, and jitter failures without another attempt', async () => {
  for (const policy of [
    { sleep: async () => { throw new Error('sleep secret') } },
    { now: () => { throw new Error('clock secret') } },
    { random: () => { throw new Error('random secret') } },
  ]) {
    let attempts = 0
    await assert.rejects(
      () => withRetry(async () => {
        attempts++
        throw new BgmNetworkError('operation secret')
      }, { stage: 'calendar', ...policy }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamFetchError)
        assert.deepEqual({ category: error.category, code: error.code, stage: error.stage, attempt: error.attempt }, {
          category: 'contract', code: 'RETRY_DELAY_FAILED', stage: 'calendar', attempt: 1,
        })
        assert.doesNotMatch(error.message, /secret|operation/i)
        assert.equal('cause' in error, false)
        return true
      },
    )
    assert.equal(attempts, 1)
  }
})
