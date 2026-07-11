import assert from 'node:assert/strict'
import test from 'node:test'
import { triggerScheduledWorkflow } from './scheduled-trigger.ts'

test('Free Plan Cron creates one deterministic live Workflow instance', async () => {
  const calls: unknown[] = []
  await triggerScheduledWorkflow({
    SYNC_WORKFLOW: {
      create: async (options) => {
        calls.push(options)
        return { id: options.id }
      },
    },
  }, 1_783_728_000_000)

  assert.deepEqual(calls, [{
    id: 'scheduled-1783728000',
    params: { mode: 'live', source: 'schedule' },
  }])
})
