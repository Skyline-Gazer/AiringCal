import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CloudflareRuntimeAdapter,
  EdgeOneRuntimeAdapter,
  PortableRuntimeAdapter,
  resolveRuntimeAdapter,
  resolveRuntimeAdapterFromEnv,
} from './index.ts'

test('resolveRuntimeAdapter maps portable and cloud ids', () => {
  assert.equal(resolveRuntimeAdapter('portable').platform_id, 'portable')
  assert.equal(resolveRuntimeAdapter('cf').platform_id, 'cloudflare')
  assert.equal(resolveRuntimeAdapter('edgeone').platform_id, 'edgeone')
})

test('portable adapter advertises CAS + read gateway', () => {
  const caps = new PortableRuntimeAdapter().capabilities()
  assert.equal(caps.compare_and_swap_pointer, true)
  assert.equal(caps.serve_read_gateway, true)
})

test('cloudflare adapter advertises R2 pointer CAS (staging smoke still #72)', () => {
  assert.equal(new CloudflareRuntimeAdapter().capabilities().compare_and_swap_pointer, true)
})

test('edgeone adapter marks CAS unproven until staging (#72)', () => {
  assert.equal(new EdgeOneRuntimeAdapter().capabilities().compare_and_swap_pointer, false)
})

test('resolveRuntimeAdapterFromEnv prefers explicit platform and portable builder fallback', () => {
  assert.equal(resolveRuntimeAdapterFromEnv({ AIRINGCAL_PLATFORM: 'cf' }).platform_id, 'cloudflare')
  assert.equal(resolveRuntimeAdapterFromEnv({ AIRINGCAL_BUILDER: 'portable' }).platform_id, 'portable')
  assert.throws(() => resolveRuntimeAdapterFromEnv({}), /AIRINGCAL_PLATFORM/)
})
