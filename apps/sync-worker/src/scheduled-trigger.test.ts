import assert from 'node:assert/strict'
import test from 'node:test'
import { triggerScheduledWorkflow } from './scheduled-trigger.ts'

test('daily 20:00 UTC Cron creates one deterministic live Workflow instance', async () => {
  const calls: unknown[] = []
  const scheduledTime = Date.UTC(2026, 6, 21, 20, 0, 0)
  await triggerScheduledWorkflow({
    SYNC_WORKFLOW: {
      create: async (options) => {
        calls.push(options)
        return { id: options.id }
      },
    },
  }, scheduledTime)

  assert.deepEqual(calls, [{
    id: `scheduled-${scheduledTime / 1000}`,
    params: { mode: 'live', source: 'schedule' },
  }])
})
