import assert from 'node:assert/strict'
import test from 'node:test'
import { createSentryTracing, type SentrySdk } from './sentry.ts'
import type { TraceAttributes } from './tracing.ts'

function sdkFixture(): { sdk: SentrySdk; initOptions: unknown[]; spanOptions: unknown[]; spanCompletions: TraceAttributes[]; flushTimeouts: number[] } {
  const initOptions: unknown[] = []
  const spanOptions: unknown[] = []
  const spanCompletions: TraceAttributes[] = []
  const flushTimeouts: number[] = []
  return {
    sdk: {
      initWithoutDefaultIntegrations: (options) => { initOptions.push(options) },
      startSpan: (options, operation) => {
        spanOptions.push(options)
        return operation({ setAttributes: (attributes) => { spanCompletions.push(attributes) } })
      },
      flush: async (timeout) => { if (timeout !== undefined) flushTimeouts.push(timeout); return true },
    },
    initOptions,
    spanOptions,
    spanCompletions,
    flushTimeouts,
  }
}

test('does not initialize or send when SENTRY_DSN is absent', async () => {
  const { sdk, initOptions, spanOptions, flushTimeouts } = sdkFixture()
  const tracing = createSentryTracing({}, sdk)
  let calls = 0

  assert.equal(await tracing.span({ name: 'vps-sync.run', attributes: {} }, async () => ++calls), 1)
  await tracing.flush()
  assert.deepEqual(initOptions, [])
  assert.deepEqual(spanOptions, [])
  assert.deepEqual(flushTimeouts, [])
})

test('uses default sample rate and disables default integrations plus PII', () => {
  const { sdk, initOptions } = sdkFixture()
  createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, sdk)

  assert.deepEqual(initOptions, [{
    dsn: 'https://dsn.example.invalid/1',
    tracesSampleRate: 1,
    sendDefaultPii: false,
  }])
})

test('accepts only finite sampling rates in the inclusive zero-to-one range', () => {
  for (const value of ['0', '0.25', '1']) {
    const { sdk, initOptions } = sdkFixture()
    createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1', SENTRY_TRACES_SAMPLE_RATE: value }, sdk)
    assert.equal((initOptions[0] as { tracesSampleRate: number }).tracesSampleRate, Number(value))
  }
  for (const value of ['-0.1', '1.1', 'Infinity', 'NaN', '']) {
    const { sdk, initOptions } = sdkFixture()
    createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1', SENTRY_TRACES_SAMPLE_RATE: value }, sdk)
    assert.deepEqual(initOptions, [])
  }
})

test('initialization failure falls open without calling the SDK again', async () => {
  let calls = 0
  const tracing = createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, {
    initWithoutDefaultIntegrations: () => { throw new Error('init unavailable') },
    startSpan: () => { throw new Error('must not start') },
    flush: async () => { throw new Error('must not flush') },
  })

  assert.equal(await tracing.span({ name: 'vps-sync.run', attributes: {} }, async () => ++calls), 1)
  await tracing.flush()
  assert.equal(calls, 1)
})

test('sync and async startSpan failures execute the business operation exactly once', async () => {
  const failures: SentrySdk['startSpan'][] = [
    () => { throw new Error('sync span failure') },
    <T>() => Promise.reject(new Error('async span failure')) as T,
  ]
  for (const startSpan of failures) {
    let calls = 0
    const tracing = createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, {
      initWithoutDefaultIntegrations: () => undefined,
      startSpan,
      flush: async () => true,
    })
    assert.equal(await tracing.span({ name: 'vps-sync.run', attributes: {} }, async () => ++calls), 1)
    assert.equal(calls, 1)
  }
})

test('a span failure after its callback preserves the completed business result', async () => {
  let calls = 0
  const tracing = createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, {
    initWithoutDefaultIntegrations: () => undefined,
    startSpan: <T>(_options: { name: string; attributes: TraceAttributes }, operation: (span: { setAttributes(attributes: TraceAttributes): unknown }) => T) => (async () => {
      await operation({ setAttributes: () => undefined })
      throw new Error('span transport failure')
    })() as T,
    flush: async () => true,
  })

  assert.equal(await tracing.span({ name: 'vps-sync.run', attributes: {} }, async () => ++calls), 1)
  assert.equal(calls, 1)
})

test('a span failure after its callback preserves the business rejection', async () => {
  const businessFailure = new Error('business failure')
  let calls = 0
  const tracing = createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, {
    initWithoutDefaultIntegrations: () => undefined,
    startSpan: <T>(_options: { name: string; attributes: TraceAttributes }, operation: (span: { setAttributes(attributes: TraceAttributes): unknown }) => T) => {
      void Promise.resolve(operation({ setAttributes: () => undefined })).catch(() => undefined)
      return Promise.reject(new Error('span transport failure')) as T
    },
    flush: async () => true,
  })

  await assert.rejects(
    () => tracing.span({ name: 'vps-sync.run', attributes: {} }, async () => {
      calls += 1
      throw businessFailure
    }),
    (error) => error === businessFailure,
  )
  assert.equal(calls, 1)
})

test('sets complete attributes on the span that completed and swallows bounded flush failures', async () => {
  const { sdk, spanOptions, spanCompletions, flushTimeouts } = sdkFixture()
  sdk.flush = async (timeout) => { if (timeout !== undefined) flushTimeouts.push(timeout); throw new Error('transport unavailable') }
  const tracing = createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, sdk)
  await tracing.span({
    name: 'vps-sync.run',
    attributes: { mode: 'shadow' },
    completeAttributes: () => ({ status: 'success', 'count.users': 1 }),
  }, async () => undefined)
  await tracing.flush()

  assert.deepEqual(spanOptions, [{ name: 'vps-sync.run', attributes: { mode: 'shadow' } }])
  assert.deepEqual(spanCompletions, [{ status: 'success', 'count.users': 1 }])
  assert.deepEqual(flushTimeouts, [2000])
})

test('bounds a never-settling SDK flush at two seconds with controlled time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { sdk } = sdkFixture()
  sdk.flush = async () => new Promise<boolean>(() => undefined)
  const tracing = createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, sdk)
  let settled = false
  const flush = tracing.flush().then(() => { settled = true })

  await Promise.resolve()
  t.mock.timers.tick(1_999)
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await flush
  assert.equal(settled, true)
})

test('clears the bounded flush timer after an immediate flush', async (t) => {
  const originalClearTimeout = globalThis.clearTimeout
  let clears = 0
  t.mock.method(globalThis, 'clearTimeout', (...args: Parameters<typeof clearTimeout>) => {
    clears += 1
    return originalClearTimeout(...args)
  })
  const { sdk } = sdkFixture()
  const tracing = createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, sdk)

  await tracing.flush()
  assert.equal(clears, 1)
})
