import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFeishuMessage, signFeishu } from './feishu.ts'
import { redactText } from './redact.ts'
import type { RunResult } from '../contracts.ts'

const result = (status: RunResult['status']): RunResult => ({
  id: 'run-123', mode: 'live', source: 'scheduled', stage: 'finished', status,
  heartbeatAt: '2026-09-10T02:03:04.000Z', finishedAt: '2026-09-10T02:03:04.000Z',
  counts: { users: 2, collections: 3, inserted: 4, updated: 5 },
  stageDurations: { collection: 1200, publication: 3400, backup: 5600 },
  sanitizedError: { category: 'runtime', code: 'STAGE_FAILED', attemptCount: 1, stage: 'backup' },
  components: { collection: 'success', calendar: 'success', media: 'partial', publication: status === 'no_change' ? 'no_change' : 'success', backup: status === 'partial' ? 'failed' : 'success', notification: 'not_attempted' },
  publication: { status: status === 'no_change' ? 'no_change' : 'published', generation: 7, contentHash: 'a'.repeat(64) },
})

test('signs the empty body with timestamp and secret per the official custom-bot contract', () => {
  assert.equal(signFeishu('1599360473', 'demo'), 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=')
})

test('builds a sanitized Feishu text payload for every terminal run status', () => {
  for (const status of ['success', 'no_change', 'partial', 'failed', 'skipped'] as const) {
    const body = buildFeishuMessage({ ...result(status), gitSha: 'b'.repeat(40) }, { category: 'runtime', code: 'NOTIFICATION_FAILED', stage: 'notification' })
    assert.deepEqual(Object.keys(body).sort(), ['content', 'msg_type'])
    assert.equal(body.msg_type, 'text')
    const text = body.content.text
    const backup = status === 'partial' ? 'failed' : 'success'
    for (const value of [status, 'run-123', 'live', 'scheduled', '2026', 'generation=7', 'hash=' + 'a'.repeat(64), 'users=2', 'collections=3', 'collection=1200ms', `backup=${backup}`, 'git_sha=' + 'b'.repeat(40), 'node=', 'alpine=unknown', 'previous_failure=runtime/NOTIFICATION_FAILED/notification']) assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('redacts URL, token, header and raw exception-like text before it reaches a Feishu payload', () => {
  const unsafe = 'https://hook.example/path?token=very-secret Authorization: Bearer abc.def X-Api-Key: hidden raw exception'
  const failed = result('failed') as RunResult & { sanitizedError: { category: string; code: string; attemptCount: number; stage: string } }
  failed.sanitizedError = { category: unsafe, code: unsafe, attemptCount: 1, stage: unsafe }
  const text = buildFeishuMessage(failed, { category: unsafe, code: unsafe, stage: unsafe }).content.text
  for (const marker of ['hook.example', 'very-secret', 'Bearer abc.def', 'hidden', 'raw exception']) assert.doesNotMatch(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, /\[redacted\]/)
  assert.equal(redactText(unsafe), '[redacted]')
})

test('redacts database and R2 credentials from both notification error fields', () => {
  const databaseUrl = 'postgresql://sync-user:database-secret@postgres.example/airing?sslmode=require'
  const accessKey = 'R2_ACCESS_KEY_ID=r2-access-secret'
  const secretKey = 'R2_SECRET_ACCESS_KEY=r2-secret'
  const failed = result('failed') as RunResult & { sanitizedError: { category: string; code: string; attemptCount: number; stage: string } }
  failed.sanitizedError = { category: databaseUrl, code: accessKey, attemptCount: 1, stage: secretKey }
  const text = buildFeishuMessage(failed, { category: databaseUrl, code: accessKey, stage: secretKey }).content.text
  for (const secret of ['sync-user', 'database-secret', 'postgres.example', 'r2-access-secret', 'r2-secret']) assert.doesNotMatch(text, new RegExp(secret))
  assert.match(text, /\[redacted\]/)
})
