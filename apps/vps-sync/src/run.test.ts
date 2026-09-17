import assert from 'node:assert/strict'
import test from 'node:test'
import { exitCode, runOnce } from './run.js'
import type { RunDependencies, RunResult } from './contracts.js'
import { UpstreamFetchError } from './upstream/retry.js'

function fixture() {
  const events: string[] = []
  const finished: unknown[] = []
  const notified: RunResult[] = []
  const deps: RunDependencies = {
    runId: 'run-1',
    gitSha: 'a'.repeat(40),
    now: () => Date.parse('2026-08-31T00:00:00Z'),
    lock: {
      acquire: async () => { events.push('lock'); return true },
      release: async () => { events.push('unlock') },
    },
    authority: {
      beginRun: async () => { events.push('begin') },
      heartbeat: async (_id, stage) => { events.push(`heartbeat:${stage}`) },
      commitCompleteState: async () => { events.push('commit') },
      finishRun: async (result) => { events.push('finish'); finished.push(structuredClone(result)) },
    },
    fetchComplete: async () => {
      events.push('fetch')
      return {
        run_id: 'run-1', observed_at: 1_788_134_400, complete: true,
        configured_user_ids: ['u'],
        users: [{ user_id: 'u', upstream_username: 'alice', complete: true, items: [] }],
        subjects: [], calendar: [],
      }
    },
    media: async () => { events.push('media'); return { selected: 0, succeeded: 0, failed: 0 } },
    publish: async () => { events.push('publish'); return { status: 'published', generation: 1, contentHash: 'a'.repeat(64) } },
    backup: async () => { events.push('backup') },
    notify: async (result) => { events.push('notify'); notified.push(structuredClone(result)) },
    close: async () => { events.push('close') },
  }
  return { deps, events, finished, notified }
}

const request = { mode: 'shadow', source: 'manual' } as const

test('coordinates complete input, heartbeat, publication, backup and notification in order', async () => {
  const { deps, events } = fixture()
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'success')
  assert.deepEqual(events.filter((event) => !event.startsWith('heartbeat:')), [
    'lock', 'begin', 'fetch', 'commit', 'media', 'publish', 'backup', 'finish', 'notify', 'finish', 'unlock', 'close',
  ])
  assert.ok(events.includes('heartbeat:collection'))
  assert.ok(events.includes('heartbeat:media'))
})

test('propagates the dependency Git SHA through the terminal result and notifier input', async () => {
  const { deps, finished, notified } = fixture()
  const result = await runOnce(deps, request)
  assert.equal(result.gitSha, deps.gitSha)
  assert.equal(finished[0] && (finished[0] as RunResult).gitSha, deps.gitSha)
  assert.equal(notified[0]?.gitSha, deps.gitSha)
})

test('lock miss persists and notifies skipped without upstream or object writes', async () => {
  const { deps, events } = fixture()
  deps.lock.acquire = async () => false
  assert.equal((await runOnce(deps, request)).status, 'skipped')
  assert.deepEqual(events, ['begin', 'finish', 'heartbeat:notification', 'notify', 'finish', 'close'])
})

test('hard fetch failure preserves authority and returns a stable sanitized error', async () => {
  const { deps, events } = fixture()
  deps.fetchComplete = async () => { throw new Error('secret URL and response body') }
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'failed')
  assert.ok(!events.includes('commit') && !events.includes('publish') && !events.includes('backup'))
  assert.doesNotMatch(JSON.stringify(result), /secret URL/)
})

test('media failure remains partial while publication and backup still run', async () => {
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

test('no change still backs up and backup failure becomes partial', async () => {
  const { deps, events } = fixture()
  deps.publish = async () => ({ status: 'no_change', generation: 1, contentHash: 'a'.repeat(64) })
  assert.equal((await runOnce(deps, request)).status, 'no_change')
  assert.ok(events.includes('backup'))
  deps.backup = async () => { throw new Error('backup secret') }
  deps.notify = async () => { throw new Error('webhook secret') }
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'partial')
  assert.equal(result.components.notification, 'failed')
})

test('backup failure after publication or no change preserves publication and persists partial', async () => {
  for (const publication of [
    { status: 'published', generation: 2, contentHash: 'b'.repeat(64) },
    { status: 'no_change', generation: 2, contentHash: 'b'.repeat(64) },
  ] as const) {
    const { deps, finished } = fixture()
    deps.publish = async () => publication
    deps.backup = async () => { throw new Error('backup upload failed') }

    const result = await runOnce(deps, request)
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.publication, publication)
    assert.equal(result.components.publication, publication.status === 'published' ? 'success' : 'no_change')
    assert.equal(result.components.backup, 'failed')
    assert.equal(finished[0] && (finished[0] as typeof result).status, 'partial')
    assert.deepEqual((finished[0] as typeof result).publication, publication)
  }
})

test('terminal outcomes have explicit process exit mapping', () => {
  for (const status of ['success', 'no_change', 'skipped'] as const) assert.equal(exitCode(status), 0)
  for (const status of ['partial', 'failed'] as const) assert.equal(exitCode(status), 1)
})

test('preserves trusted upstream classification without raw error text', async () => {
  const { deps } = fixture()
  deps.fetchComplete = async () => { throw new UpstreamFetchError('rate_limited', 'UPSTREAM_RATE_LIMITED', 'calendar', 3) }
  const result = await runOnce(deps, request)
  assert.deepEqual(result.sanitizedError, {
    category: 'rate_limited', code: 'UPSTREAM_RATE_LIMITED', stage: 'calendar', attemptCount: 3,
  })
  assert.equal(result.components.calendar, 'failed')
})

test('continues heartbeat during long stages and drains its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { deps, events } = fixture()
  deps.fetchComplete = async () => {
    t.mock.timers.tick(30_000)
    await Promise.resolve()
    return {
      run_id: 'run-1', observed_at: 1_788_134_400, complete: true,
      configured_user_ids: ['u'], users: [{ user_id: 'u', upstream_username: 'alice', complete: true, items: [] }],
      subjects: [], calendar: [],
    }
  }
  await runOnce(deps, request)
  assert.ok(events.filter((event) => event === 'heartbeat:collection').length >= 2)
  const count = events.length
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.equal(events.length, count)
})
