import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateProbeResults } from './v3-ship-verify.mjs'

test('verdict passes only when every probe passes', () => {
  assert.deepEqual(evaluateProbeResults([{ name: 'a', pass: true }]), { pass: true, failed: [] })
  assert.deepEqual(evaluateProbeResults([{ name: 'a', pass: true }, { name: 'b', pass: false }]),
    { pass: false, failed: ['b'] })
  assert.equal(evaluateProbeResults([]).pass, false, 'empty probe set must not pass')
})

test('null (skipped) probes are failures', () => {
  assert.equal(evaluateProbeResults([{ name: 'optional', pass: null }]).pass, false)
})
