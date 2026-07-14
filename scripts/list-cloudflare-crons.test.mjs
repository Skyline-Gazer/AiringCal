import assert from 'node:assert/strict'
import test from 'node:test'

import { cronQuotaStatus } from './list-cloudflare-crons.mjs'

test('cron quota allows deploy when target worker already owns a trigger at the plan limit', () => {
  const status = cronQuotaStatus([
    { worker: 'airing-cal-sync', cron: '0 * * * *' },
    { worker: 'bangumi-tv', cron: '0 */4 * * *' },
    { worker: 'glados-workers', cron: '*/30 * * * *' },
    { worker: 'nodewarden', cron: '*/5 * * * *' },
    { worker: 'prd-223-ghcard-cache', cron: '17 */6 * * *' },
  ])

  assert.equal(status.count, 5)
  assert.equal(status.targetHasCron, true)
  assert.equal(status.canDeployTargetCron, true)
})

test('cron quota blocks deploy when target worker would need a new trigger at the plan limit', () => {
  const status = cronQuotaStatus([
    { worker: 'bangumi-tv', cron: '0 */4 * * *' },
    { worker: 'glados-workers', cron: '*/30 * * * *' },
    { worker: 'nodewarden', cron: '*/5 * * * *' },
    { worker: 'prd-223-ghcard-cache', cron: '17 */6 * * *' },
    { worker: 'another-worker', cron: '0 0 * * *' },
  ])

  assert.equal(status.count, 5)
  assert.equal(status.targetHasCron, false)
  assert.equal(status.canDeployTargetCron, false)
})
