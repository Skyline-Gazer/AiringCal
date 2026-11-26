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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPrivateObjectProof, mirrorObjectStore } from './v3-ship-verify.mjs'

function collect() {
  const probes = []
  const rec = (name, pass, detail) => probes.push({ name, pass: pass === true, detail })
  return { probes, rec }
}

test('positive proof: real checkpoint object + anonymous denial passes', async () => {
  const { probes, rec } = collect()
  await runPrivateObjectProof(rec, {
    bucket: 'airingcal-development',
    store: {
      async list() { return ['checkpoints/latest.sqlite', 'checkpoints/lease.json'] },
      async head() { return { size: 4096 } },
    },
    async probe(key, method) { return { status: method === 'GET' ? 404 : 403 } },
  })
  assert.deepEqual(
    probes.map((p) => [p.name, p.pass]),
    [
      ['private-object-exists', true],
      ['anon-get-private-key-denied', true],
      ['anon-head-private-key-denied', true],
    ],
  )
})

test('a 2xx anonymous response on the proven key fails the isolation proof', async () => {
  const { probes, rec } = collect()
  await runPrivateObjectProof(rec, {
    bucket: 'b',
    store: { async list() { return ['checkpoints/lease.json'] }, async head() { return { size: 2 } } },
    async probe() { return { status: 200 } },
  })
  assert.equal(evaluateProbeResults(probes).pass, false)
  assert.ok(probes.some((p) => p.name === 'anon-get-private-key-denied' && p.pass === false))
})

test('empty or failing listings fail closed — a 404 over nothing proves nothing', async () => {
  const empty = collect()
  await runPrivateObjectProof(empty.rec, {
    bucket: 'b',
    store: { async list() { return ['checkpoints/'] }, async head() { return { size: 1 } } },
    async probe() { return { status: 404 } },
  })
  assert.equal(evaluateProbeResults(empty.probes).pass, false)
  assert.match(empty.probes[0].name, /private-object-proof/)

  const throwing = collect()
  await runPrivateObjectProof(throwing.rec, {
    bucket: 'b',
    store: { async list() { throw new Error('AccessDenied') }, async head() { return null } },
    async probe() { return { status: 404 } },
  })
  assert.equal(throwing.probes[0].pass, false)
  assert.match(throwing.probes[0].detail, /AccessDenied/)
})

test('listed keys that vanish before HEAD are not positive proof', async () => {
  const { probes, rec } = collect()
  await runPrivateObjectProof(rec, {
    bucket: 'b',
    store: { async list() { return ['checkpoints/latest.sqlite'] }, async head() { return null } },
    async probe() { return { status: 404 } },
  })
  assert.equal(evaluateProbeResults(probes).pass, false)
  assert.match(probes.map((p) => p.name).join(','), /private-object-exists/)
})

test('mirrorObjectStore walks a local checkpoints tree read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-mirror-'))
  mkdirSync(join(dir, 'checkpoints', 'leases'), { recursive: true })
  writeFileSync(join(dir, 'checkpoints', 'latest.sqlite'), 'x'.repeat(10))
  writeFileSync(join(dir, 'checkpoints', 'leases', 'owner.json'), '{}')
  const store = mirrorObjectStore(dir)
  assert.deepEqual(
    (await store.list('checkpoints/')).sort(),
    ['checkpoints/latest.sqlite', 'checkpoints/leases/owner.json'],
  )
  assert.deepEqual(await store.head('checkpoints/latest.sqlite'), { size: 10, etag: null, contentType: null })
  assert.equal(await store.head('checkpoints/nope.bin'), null)
})
