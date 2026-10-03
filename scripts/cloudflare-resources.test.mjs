import assert from 'node:assert/strict'
import test from 'node:test'
import { provisionCloudflareResources } from './provision-cloudflare-resources.mjs'
import { resolveCloudflareResources } from './resolve-cloudflare-resources.mjs'

test('bootstrap creates D1 and private-default R2 buckets once; deployment only resolves online resources', async () => {
  const databases = [], buckets = [], writes = []
  const fetchImpl = async (url, init = {}) => {
    const d1 = new URL(url).pathname.endsWith('/d1/database')
    assert.equal(d1 || new URL(url).pathname.endsWith('/r2/buckets'), true)
    const entries = d1 ? databases : buckets
    if (init.method === 'POST') {
      writes.push(url)
      entries.push({ ...JSON.parse(init.body), ...(d1 ? { uuid: '11111111-1111-4111-8111-111111111111' } : {}) })
    }
    return { ok: true, async json() { return { success: true, result: init.method === 'POST' ? entries.at(-1) : (d1 ? entries : { buckets: entries }) } } }
  }
  const options = { env: { CLOUDFLARE_API_TOKEN: 'offline', CLOUDFLARE_ACCOUNT_ID: 'offline' }, fetchImpl }
  await provisionCloudflareResources(options)
  await provisionCloudflareResources(options)
  assert.equal(writes.length, 4)
  assert.deepEqual(buckets.map(bucket => bucket.name), ['airing-cal-data', 'airing-cal-images', 'airing-cal-backups'])
  const resolved = await resolveCloudflareResources(options)
  assert.equal(resolved.d1DatabaseId, databases[0].uuid)
  assert.equal(writes.length, 4)
})
