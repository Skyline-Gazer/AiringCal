import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cronQuotaStatus,
  parseWranglerCronDeploy,
  projectCronRowsAfterDeploy,
} from './list-cloudflare-crons.mjs'

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

test('parseWranglerCronDeploy reads worker name and optional crons', () => {
  assert.deepEqual(parseWranglerCronDeploy(`name = "airing-cal-frontend"\n`), {
    worker: 'airing-cal-frontend',
    crons: [],
  })
  assert.deepEqual(parseWranglerCronDeploy(`name = "airing-cal-sync"\n[triggers]\ncrons = ["0 20 * * *"]\n`), {
    worker: 'airing-cal-sync',
    crons: ['0 20 * * *'],
  })
})

test('projectCronRowsAfterDeploy drops frontend cron when deploy removes triggers', () => {
  const accountRows = [
    { worker: 'airing-cal-frontend', cron: '15 * * * *' },
    { worker: 'nodewarden', cron: '*/5 * * * *' },
    { worker: 'pastebin-prod', cron: '0 0 * * *' },
    { worker: 'cfworker4alicdt', cron: '*/10 * * * *' },
    { worker: 'prd-223-ghcard-cache', cron: '17 */6 * * *' },
  ]
  const projected = projectCronRowsAfterDeploy(accountRows, [
    { worker: 'airing-cal-frontend', crons: [] },
  ])
  assert.equal(projected.length, 4)
  assert.ok(!projected.some((row) => row.worker === 'airing-cal-frontend'))
  assert.equal(cronQuotaStatus(projected).canDeployTargetCron, true)
})
