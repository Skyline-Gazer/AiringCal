import assert from 'node:assert/strict'
import test from 'node:test'
import { noOpTracing } from './tracing.ts'

test('no-op tracing executes an operation exactly once and never adds attributes', async () => {
  let calls = 0
  const result = await noOpTracing.span(
    { name: 'vps-sync.run', attributes: { mode: 'shadow', source: 'manual' } },
    async () => {
      calls += 1
      return 'business-result'
    },
  )

  assert.equal(result, 'business-result')
  assert.equal(calls, 1)
  await noOpTracing.flush()
})
