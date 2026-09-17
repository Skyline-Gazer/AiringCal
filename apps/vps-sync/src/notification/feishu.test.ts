import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunResult } from '../contracts.js'
import { buildFeishuMessage, signFeishu } from './feishu.js'
import { redactText } from './redact.js'

function result(status: RunResult['status']): RunResult {
  const publication = status === 'success'
    ? { status: 'published' as const, generation: 7, contentHash: 'a'.repeat(64) }
    : status === 'no_change'
      ? { status: 'no_change' as const, generation: 7, contentHash: 'a'.repeat(64) }
      : status === 'partial'
        ? { status: 'published' as const, generation: 7, contentHash: 'a'.repeat(64) }
        : { status: status === 'failed' ? 'failed' as const : 'skipped' as const }
  return {
    id: 'run-123', mode: 'live', source: 'scheduled', stage: 'finished', status,
    heartbeatAt: '2026-09-10T02:03:04.000Z', finishedAt: '2026-09-10T02:03:04.000Z',
    counts: { users: 2, collections: 3, inserted: 4, updated: 5, mediaSelected: 6, mediaSucceeded: 5, mediaFailed: 1 },
    stageDurations: { collection: 1200, publication: 3400, backup: 5600 },
    sanitizedError: status === 'success' || status === 'no_change' ? null : { category: 'runtime', code: 'STAGE_FAILED', attemptCount: 1, stage: 'backup' },
    components: {
      collection: status === 'skipped' ? 'not_attempted' : 'success',
      calendar: status === 'skipped' ? 'not_attempted' : 'success',
      media: status === 'partial' ? 'partial' : status === 'skipped' ? 'not_attempted' : 'success',
      publication: status === 'no_change' ? 'no_change' : status === 'success' || status === 'partial' ? 'success' : status,
      backup: status === 'partial' ? 'failed' : status === 'success' || status === 'no_change' ? 'success' : 'not_attempted',
      notification: 'not_attempted',
    },
    publication,
  }
}

test('signs the empty body with timestamp and secret per the official custom-bot contract', () => {
  assert.equal(signFeishu('1599360473', 'demo'), 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=')
})

test('builds a sanitized Feishu text payload for every terminal run status', () => {
  for (const status of ['success', 'no_change', 'partial', 'failed', 'skipped'] as const) {
    const body = buildFeishuMessage(result(status), { category: 'runtime', code: 'NOTIFICATION_FAILED', stage: 'notification' })
    assert.deepEqual(Object.keys(body).sort(), ['content', 'msg_type'])
    assert.equal(body.msg_type, 'text')
    const text = body.content.text
    for (const value of [
      status, 'run-123', 'live', 'scheduled', '2026', 'users=2', 'collections=3', 'inserted=4', 'updated=5',
      'mediaSelected=6', 'mediaSucceeded=5', 'mediaFailed=1', 'collection=1200ms', 'publication=3400ms', 'backup=5600ms',
      'duration=10200ms', 'backup=', 'git_sha=unknown', `node=${process.version}`, 'alpine=unknown', 'previous_failure=runtime/NOTIFICATION_FAILED/notification',
    ]) assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')))
    assert.match(text, /generation=(?:7|none) hash=(?:a{64}|none)/)
  }
})

test('formats terminal time in Asia/Shanghai without relying on host timezone', () => {
  const text = buildFeishuMessage(result('success')).content.text
  assert.match(text, /time=.*2026.*10:03:04/)
})

test('redacts URL, token, header and raw exception-like text before it reaches a Feishu payload', () => {
  const unsafe = 'https://hook.example/path?token=very-secret Authorization: Bearer abc.def X-Api-Key: hidden raw exception'
  const failed = result('failed')
  failed.sanitizedError = { category: unsafe, code: unsafe, attemptCount: 1, stage: unsafe }
  const text = buildFeishuMessage(failed, { category: unsafe, code: unsafe, stage: unsafe }).content.text
  for (const marker of ['hook.example', 'very-secret', 'Bearer abc.def', 'hidden', 'raw exception']) assert.doesNotMatch(text, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')))
  assert.match(text, /\[redacted\]/)
  assert.equal(redactText(unsafe), '[redacted]')
})

test('redacts database and R2 credentials from notification error fields', () => {
  const databaseUrl = 'postgresql://sync-user:database-secret@postgres.example/airing?sslmode=require'
  const accessKey = 'R2_ACCESS_KEY_ID=r2-access-secret'
  const secretKey = 'R2_SECRET_ACCESS_KEY=r2-secret'
  const failed = result('failed')
  failed.sanitizedError = { category: databaseUrl, code: accessKey, attemptCount: 1, stage: secretKey }
  const text = buildFeishuMessage(failed, { category: databaseUrl, code: accessKey, stage: secretKey }).content.text
  for (const secret of ['sync-user', 'database-secret', 'postgres.example', 'r2-access-secret', 'r2-secret']) assert.doesNotMatch(text, new RegExp(secret))
  assert.match(text, /\[redacted\]/)
})
