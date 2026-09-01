import assert from 'node:assert/strict'
import test from 'node:test'
import { runOnce, exitCode } from './run.ts'
import type { RunDependencies } from './contracts.ts'
import type { TraceAttributes, TracingPort } from './observability/tracing.ts'
import { createSentryTracing, type SentrySdk } from './observability/sentry.ts'
import { UpstreamFetchError } from './upstream/retry.ts'

function fixture() {
  const events: string[] = []
  const finished: unknown[] = []
  const notified: unknown[] = []
  const deps: RunDependencies = {
    runId: 'run-1', gitSha: 'a'.repeat(40), now: () => Date.parse('2026-08-31T00:00:00Z'),
    lock: { acquire: async () => { events.push('lock'); return true }, release: async () => { events.push('unlock') } },
    authority: {
      beginRun: async () => { events.push('begin') },
      heartbeat: async (_id, stage) => { events.push(`heartbeat:${stage}`) },
      commitCompleteState: async () => { events.push('commit') },
      finishRun: async (result) => { events.push('finish'); finished.push(structuredClone(result)) },
    },
    fetchComplete: async () => { events.push('fetch'); return { runId: 'run-1', observedAt: '2026-08-31T00:00:00Z', users: [{ id: '11111111-1111-1111-1111-111111111111', upstreamUserId: '42', items: [] }], calendarEntries: [] } },
    media: async () => { events.push('media'); return { selected: 0, succeeded: 0, failed: 0 } },
    publish: async () => { events.push('publish'); return { status: 'published', generation: 1, contentHash: 'a'.repeat(64) } },
    backup: async () => { events.push('backup') },
    notify: async (result) => { events.push('notify'); notified.push(structuredClone(result)) },
    close: async () => { events.push('close') },
  }
  return { deps, events, finished, notified }
}
const request = { mode: 'shadow', source: 'manual' } as const

test('coordinates complete input, heartbeat, publication, backup and persisted notification in order', async () => {
  const { deps, events } = fixture()
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'success')
  assert.deepEqual(events.filter((e) => !e.startsWith('heartbeat')), ['lock', 'begin', 'fetch', 'commit', 'media', 'publish', 'backup', 'unlock', 'finish', 'notify', 'finish', 'close'])
  assert.ok(events.includes('heartbeat:collection'))
  assert.ok(events.includes('heartbeat:media'))
})
test('lock miss persists and notifies skipped without upstream or object writes', async () => {
  const { deps, events } = fixture()
  deps.lock.acquire = async () => false
  assert.equal((await runOnce(deps, request)).status, 'skipped')
  assert.deepEqual(events, ['begin', 'finish', 'heartbeat:notification', 'notify', 'finish', 'close'])
})
test('hard fetch failure preserves authority and returns only a stable sanitized error', async () => {
  const { deps, events } = fixture()
  deps.fetchComplete = async () => { throw new Error('secret URL and response body') }
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'failed')
  assert.ok(!events.includes('commit') && !events.includes('publish') && !events.includes('backup'))
  assert.doesNotMatch(JSON.stringify(result), /secret URL/)
  assert.ok(events.indexOf('unlock') < events.indexOf('finish'))
  assert.equal(events.at(-1), 'close')
})
test('media failure remains partial but publication and backup are attempted', async () => {
  const { deps, events } = fixture()
  deps.media = async () => ({ selected: 1, succeeded: 0, failed: 1 })
  assert.equal((await runOnce(deps, request)).status, 'partial')
  assert.ok(events.includes('publish') && events.includes('backup'))
})
test('publication failure or skip never triggers backup', async () => {
  for (const status of ['failed', 'skipped'] as const) {
    const { deps, events } = fixture()
    deps.publish = async () => ({ status })
    const result = await runOnce(deps, request)
    assert.equal(result.status, status === 'failed' ? 'failed' : 'skipped')
    assert.ok(!events.includes('backup'))
  }
})
test('no change still backs up; backup failure is partial; notification does not alter business outcome', async () => {
  const { deps, events } = fixture()
  deps.publish = async () => ({ status: 'no_change', generation: 1, contentHash: 'a'.repeat(64) })
  assert.equal((await runOnce(deps, request)).status, 'no_change')
  assert.ok(events.includes('backup'))
  deps.backup = async () => { throw new Error('secret') }
  deps.notify = async () => { throw new Error('webhook secret') }
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'partial')
  assert.equal(result.components.notification, 'failed')
})
test('terminal outcomes have explicit process exit mapping', () => {
  for (const status of ['success', 'no_change', 'skipped'] as const) assert.equal(exitCode(status), 0)
  for (const status of ['partial', 'failed'] as const) assert.equal(exitCode(status), 1)
})

test('preserves trusted upstream classification and attempts without raw error text', async () => {
  const { deps } = fixture()
  deps.fetchComplete = async () => { throw new UpstreamFetchError('rate_limited', 'UPSTREAM_RATE_LIMITED', 'calendar', 3) }
  const result = await runOnce(deps, request)
  assert.deepEqual(result.sanitizedError, { category: 'rate_limited', code: 'UPSTREAM_RATE_LIMITED', stage: 'calendar', attemptCount: 3 })
  assert.equal(result.components.calendar, 'failed')
})

test('continues heartbeat during long stages and drains timer before releasing resources', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { deps, events } = fixture()
  deps.fetchComplete = async () => {
    t.mock.timers.tick(30000)
    await Promise.resolve()
    return { runId: 'run-1', observedAt: '2026-08-31T00:00:00Z', users: [], calendarEntries: [] }
  }
  await runOnce(deps, request)
  assert.ok(events.filter((event) => event === 'heartbeat:collection').length >= 2)
  const count = events.length
  t.mock.timers.tick(60000)
  await Promise.resolve()
  assert.equal(events.length, count)
})

test('periodic heartbeat failure preserves committed authority counts and later side effects', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { deps, events, finished } = fixture()
  let collectionHeartbeats = 0
  deps.authority.heartbeat = async (_id, stage) => {
    events.push(`heartbeat:${stage}`)
    if (stage === 'collection' && ++collectionHeartbeats === 2) throw new Error('database heartbeat')
  }
  deps.fetchComplete = async () => {
    t.mock.timers.tick(30000)
    await Promise.resolve()
    return { runId: 'run-1', observedAt: '2026-08-31T00:00:00Z', users: [], calendarEntries: [] }
  }
  deps.authority.commitCompleteState = async () => ({ inserted: 4, updated: 3, unchanged: 2, deleted: 1, missing: 0, restored: 0 })
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'partial')
  assert.equal(result.counts.inserted, 4)
  assert.equal(result.counts.updated, 3)
  assert.deepEqual(result.publication, { status: 'published', generation: 1, contentHash: 'a'.repeat(64) })
  assert.ok(events.includes('backup'))
  assert.equal((finished.at(-1) as { status: string }).status, 'partial')
})

test('notification heartbeat failure sends one final degraded correction and drains its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { deps, events, finished, notified } = fixture()
  let notificationHeartbeats = 0
  deps.authority.heartbeat = async (_id, stage) => {
    events.push(`heartbeat:${stage}`)
    if (stage === 'notification' && ++notificationHeartbeats === 2) throw new Error('database heartbeat')
  }
  deps.notify = async (result) => {
    events.push('notify')
    notified.push(structuredClone(result))
    t.mock.timers.tick(30000)
    await Promise.resolve()
  }
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'partial')
  assert.deepEqual(notified.map((value) => (value as { status: string }).status), ['success', 'partial'])
  assert.equal((finished.at(-1) as { status: string }).status, 'partial')
  assert.equal(events.filter((event) => event === 'notify').length, 2)
  const count = events.length
  t.mock.timers.tick(60000)
  await Promise.resolve()
  assert.equal(events.length, count)
})

test('an initial heartbeat failure marks its stage span and root span failed', async () => {
  const { deps } = fixture()
  const spans: Array<{ name: string; complete: TraceAttributes }> = []
  deps.authority.heartbeat = async (_id, stage) => {
    if (stage === 'collection') throw new Error('initial heartbeat failure')
  }
  deps.tracing = {
    span: async (input, operation) => {
      const record = { name: input.name, complete: {} as TraceAttributes }
      spans.push(record)
      try { return await operation() }
      finally { record.complete = { ...(input.completeAttributes?.() ?? {}) } }
    },
    flush: async () => undefined,
  }

  const result = await runOnce(deps, request)
  assert.equal(result.status, 'failed')
  assert.deepEqual(spans.map((span) => span.complete.status), ['failed', 'failed', 'success'])
})

test('records completed authority diff counts rather than selected work as completed', async () => {
  const { deps } = fixture()
  deps.authority.commitCompleteState = async () => ({ inserted: 1, updated: 2, unchanged: 3, deleted: 0, missing: 1, restored: 0 })
  const result = await runOnce(deps, request)
  assert.equal(result.counts.inserted, 1)
  assert.equal(result.counts.updated, 2)
  assert.equal(result.counts.unchanged, 3)
})

test('lock/initial persistence failures expose sanitized terminal result and always close', async () => {
  for (const failAt of ['lock', 'begin'] as const) {
    const { deps, events } = fixture()
    if (failAt === 'lock') deps.lock.acquire = async () => { throw new Error('postgres://secret') }
    else deps.authority.beginRun = async () => { throw new Error('postgres://secret') }
    const result = await runOnce(deps, request)
    assert.equal(result.status, 'failed')
    assert.doesNotMatch(JSON.stringify(result), /postgres:\/\/secret/)
    assert.equal(events.at(-1), 'close')
  }
})

test('unlock failure is reflected consistently in database, notification and return before close', async () => {
  const { deps, events, finished, notified } = fixture()
  deps.lock.release = async () => { events.push('unlock'); throw new Error('secret connection') }
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'partial')
  assert.equal((finished.at(-1) as { status: string }).status, 'partial')
  assert.equal((notified.at(-1) as { status: string }).status, 'partial')
  assert.doesNotMatch(JSON.stringify(result), /secret connection/)
  assert.equal(events.filter((event) => event === 'unlock').length, 1)
  assert.ok(events.indexOf('unlock') < events.indexOf('finish'))
  assert.equal(events.at(-1), 'close')
})

test('close failure makes a best-effort corrected persistence and notification without double unlock', async () => {
  const { deps, events, finished, notified } = fixture()
  deps.close = async () => { events.push('close'); throw new Error('secret pool') }
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'partial')
  assert.equal(events.filter((event) => event === 'unlock').length, 1)
  assert.equal(events.filter((event) => event === 'close').length, 1)
  assert.equal((finished.at(-1) as { status: string }).status, 'partial')
  assert.equal((notified.at(-1) as { status: string }).status, 'partial')
  assert.doesNotMatch(JSON.stringify(result), /secret pool/)
})

test('initialization plus close failure remains sanitized and releases an acquired lock once', async () => {
  const { deps, events } = fixture()
  deps.authority.beginRun = async () => { throw new Error('postgres://initial-secret') }
  deps.close = async () => { events.push('close'); throw new Error('postgres://close-secret') }
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'failed')
  assert.equal(events.filter((event) => event === 'unlock').length, 1)
  assert.equal(events.filter((event) => event === 'close').length, 1)
  assert.doesNotMatch(JSON.stringify(result), /postgres:\/\//)
})

test('media and publication use the completed input observation rather than process start time', async () => {
  const { deps } = fixture()
  const fetch = deps.fetchComplete
  const observedAt = '2026-08-31T00:05:00.000Z'
  deps.fetchComplete = async (context) => ({ ...await fetch(context), observedAt })
  deps.media = async (context) => {
    assert.equal(context.observedAt, observedAt)
    return { selected: 0, succeeded: 0, failed: 0 }
  }
  deps.publish = async (context) => {
    assert.equal(context.observedAt, observedAt)
    return { status: 'no_change', generation: 1, contentHash: 'a'.repeat(64) }
  }
  assert.equal((await runOnce(deps, request)).status, 'no_change')
})

test('emits only manual root and coordinator-stage allow-listed tracing attributes', async () => {
  const { deps } = fixture()
  const spans: Array<{ name: string; attributes: TraceAttributes; complete: TraceAttributes }> = []
  const tracing: TracingPort = {
    span: async (input, operation) => {
      const record = { name: input.name, attributes: { ...input.attributes }, complete: {} as TraceAttributes }
      spans.push(record)
      try { return await operation() }
      finally { record.complete = { ...(input.completeAttributes?.() ?? {}) } }
    },
    flush: async () => undefined,
  }
  deps.tracing = tracing
  deps.runId = 'run-subject-id-marker'
  deps.fetchComplete = async () => {
    throw new Error('dsn-marker https://username-marker.example.invalid/body-marker subject-id-marker raw-error-marker')
  }

  const result = await runOnce(deps, request)
  assert.equal(result.status, 'failed')
  assert.equal(spans[0]?.name, 'vps-sync.run')
  assert.deepEqual(spans[0]?.attributes, { mode: 'shadow', source: 'manual', git_sha: 'a'.repeat(40) })
  assert.deepEqual(spans.map((span) => span.name), ['vps-sync.run', 'vps-sync.stage', 'vps-sync.stage'])
  assert.deepEqual(spans[1]?.attributes, { stage: 'collection' })
  assert.deepEqual(spans[1]?.complete, { status: 'failed', duration_ms: 0 })
  assert.deepEqual(spans[2]?.attributes, { stage: 'notification' })
  assert.deepEqual(spans[2]?.complete, { status: 'success', duration_ms: 0 })
  assert.deepEqual(spans[0]?.complete, { status: 'failed', 'count.users': 0, 'count.collections': 0, duration_ms: 0 })
  const serialized = JSON.stringify(spans)
  for (const marker of ['dsn-marker', 'https://', 'username-marker', 'body-marker', 'subject-id-marker', 'raw-error-marker']) {
    assert.doesNotMatch(serialized, new RegExp(marker))
  }
})

test('tracing span and flush failures do not change run execution or exit status', async () => {
  const { deps, events } = fixture()
  let spanCalls = 0
  deps.tracing = {
    span: async () => { spanCalls += 1; throw new Error('tracing unavailable') },
    flush: async () => { throw new Error('flush unavailable') },
  }

  const result = await runOnce(deps, request)
  assert.equal(result.status, 'success')
  assert.equal(exitCode(result.status), 0)
  assert.ok(events.includes('fetch') && events.includes('notify') && events.includes('close'))
  assert.ok(spanCalls >= 1)
})

test('a rejecting injected tracer and its late root callback share one coordinator execution', async () => {
  const { deps, events } = fixture()
  const callbacks: Array<() => Promise<unknown>> = []
  deps.tracing = {
    span: async (_input, operation) => {
      callbacks.push(operation)
      throw new Error('tracing unavailable before callback')
    },
    flush: async () => undefined,
  }

  assert.equal((await runOnce(deps, request)).status, 'success')
  assert.equal((await callbacks[0]!() as { status: string }).status, 'success')
  assert.equal(events.filter((event) => event === 'fetch').length, 1)
  assert.equal(events.filter((event) => event === 'commit').length, 1)
})

test('an injected tracer that settles before its root callback cannot skip or duplicate coordinator execution', async () => {
  const { deps, events } = fixture()
  const callbacks: Array<() => Promise<unknown>> = []
  deps.tracing = {
    span: async (_input, operation) => {
      callbacks.push(operation)
      return undefined as never
    },
    flush: async () => undefined,
  }

  assert.equal((await runOnce(deps, request)).status, 'success')
  assert.equal((await callbacks[0]!() as { status: string }).status, 'success')
  assert.equal(events.filter((event) => event === 'fetch').length, 1)
  assert.equal(events.filter((event) => event === 'commit').length, 1)
})

test('root and stage tracing rejections after callbacks preserve one successful run', async () => {
  const { deps, events } = fixture()
  const calls: string[] = []
  deps.tracing = {
    span: async (input, operation) => {
      calls.push(input.name)
      await operation()
      throw new Error(`tracing failed after ${input.name}`)
    },
    flush: async () => undefined,
  }

  const result = await runOnce(deps, request)
  assert.equal(result.status, 'success')
  assert.equal(events.filter((event) => event === 'fetch').length, 1)
  assert.equal(events.filter((event) => event === 'notify').length, 1)
  assert.equal(calls.filter((name) => name === 'vps-sync.run').length, 1)
  assert.ok(calls.filter((name) => name === 'vps-sync.stage').length > 0)
})

test('Sentry ends each stage beneath the root before ending the root with terminal attributes', async () => {
  const { deps } = fixture()
  type SpanRecord = { name: string; parent?: string; attributes: TraceAttributes; complete: TraceAttributes }
  const spans: SpanRecord[] = []
  const ended: string[] = []
  const active: SpanRecord[] = []
  const sdk: SentrySdk = {
    initWithoutDefaultIntegrations: () => undefined,
    startSpan: <T>(options: { name: string; attributes: TraceAttributes }, operation: (span: { setAttributes(attributes: TraceAttributes): unknown }) => T): T => {
      const record: SpanRecord = { name: options.name, parent: active.at(-1)?.name, attributes: options.attributes, complete: {} }
      spans.push(record)
      active.push(record)
      const end = () => {
        assert.equal(active.pop(), record)
        ended.push(record.name)
      }
      try {
        const value = operation({ setAttributes: (attributes) => { Object.assign(record.complete, attributes) } })
        if (value instanceof Promise) return value.finally(end) as T
        end()
        return value
      } catch (error) {
        end()
        throw error
      }
    },
    flush: async () => true,
  }
  deps.tracing = createSentryTracing({ SENTRY_DSN: 'https://dsn.example.invalid/1' }, sdk)

  const result = await runOnce(deps, request)
  assert.equal(result.status, 'success')
  assert.equal(spans[0]?.name, 'vps-sync.run')
  assert.equal(spans[0]?.parent, undefined)
  assert.ok(spans.slice(1).every((span) => span.name === 'vps-sync.stage' && span.parent === 'vps-sync.run'))
  assert.equal(ended.at(-1), 'vps-sync.run')
  assert.deepEqual(spans[0]?.complete, {
    status: 'success',
    'count.users': 1,
    'count.collections': 0,
    duration_ms: 0,
    'count.mediaSelected': 0,
    'count.mediaSucceeded': 0,
    'count.mediaFailed': 0,
  })
  assert.ok(spans.slice(1).every((span) => span.complete.status === 'success' && span.complete.duration_ms === 0))
})
