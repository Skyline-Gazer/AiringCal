import assert from 'node:assert/strict'
import test from 'node:test'
import { publicError, sanitizeErrorMessage, syncHeaders } from './index.ts'

test('sanitizeErrorMessage removes token-like secrets from public text', () => {
  const sanitized = sanitizeErrorMessage('Authorization: Bearer secret-token-123 and access_token=abc123')

  assert.equal(sanitized.includes('secret-token-123'), false)
  assert.equal(sanitized.includes('abc123'), false)
  assert.equal(sanitized.includes('[redacted]'), true)
})

test('publicError returns stable JSON without raw error text', async () => {
  const response = publicError(502, 'BGM_UPSTREAM', new Error('Bearer secret-token leaked'))
  const body = await response.json() as any

  assert.equal(response.status, 502)
  assert.deepEqual(body, {
    ok: false,
    error: {
      code: 'BGM_UPSTREAM',
      message: 'Upstream request failed',
    },
  })
})

test('syncHeaders disables storage and framing for sensitive sync responses', () => {
  const headers = syncHeaders()

  assert.equal(headers.get('Cache-Control'), 'no-store')
  assert.equal(headers.get('X-Frame-Options'), 'DENY')
})
