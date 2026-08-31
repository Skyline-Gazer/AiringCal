import assert from 'node:assert/strict'
import test from 'node:test'
import { runOnce, exitCode } from './run.ts'
import type { RunDependencies } from './contracts.ts'
import { UpstreamFetchError } from './upstream/retry.ts'

function fixture() {
  const events: string[] = []
  const finished: unknown[] = []
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
    notify: async () => { events.push('notify') },
    close: async () => { events.push('close') },
  }
  return { deps, events, finished }
}
const request = { mode: 'shadow', source: 'manual' } as const

test('coordinates complete input, heartbeat, publication, backup and persisted notification in order', async () => {
  const { deps, events } = fixture()
  const result = await runOnce(deps, request)
  assert.equal(result.status, 'success')
  assert.deepEqual(events.filter((e) => !e.startsWith('heartbeat')), ['lock', 'begin', 'fetch', 'commit', 'media', 'publish', 'backup', 'finish', 'notify', 'finish', 'unlock', 'close'])
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
  assert.deepEqual(events.slice(-2), ['unlock', 'close'])
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
