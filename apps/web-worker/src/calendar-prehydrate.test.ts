import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './read-api.ts'

class CountingKV {
  imageStatusGets: string[] = []
  values = new Map<string, unknown>()

  async get(key: string, type?: 'json') {
    if (key.startsWith('image:status:')) this.imageStatusGets.push(key)
    const value = this.values.get(key)
    if (type === 'json') return value ?? null
    return value == null ? null : JSON.stringify(value)
  }

  async put(key: string, value: string) {
    this.values.set(key, JSON.parse(value))
  }

  async delete(key: string) {
    this.values.delete(key)
  }

  async list() {
    return { keys: [] }
  }
}

async function setActiveSnapshot(kv: CountingKV, calendar: unknown[]) {
  const instanceId = 'prehydrated'
  const completeValues = {
    'collections:want': [],
    'collections:watched': [],
    'collections:watching': [],
    'collections:on_hold': [],
    'collections:dropped': [],
    summary: { _total: 0 },
    calendar,
  }
  const digests: Record<string, string> = {}
  for (const [suffix, value] of Object.entries(completeValues)) {
    const key = `snapshot:version:${instanceId}:${suffix}`
    kv.values.set(key, value)
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    digests[key] = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  kv.values.set('snapshot:active', {
    instance_id: instanceId,
    generation: 1,
    mode: 'live',
    published_at: 1,
    subject_count: 1,
    required_keys: Object.keys(digests),
    digests,
  })
}

test('read-worker calendar skips KV hydration when publish prehydrated image_status is present', async () => {
  const hash = 'b'.repeat(64)
  const kv = new CountingKV()
  await setActiveSnapshot(kv, [{
    weekday: { id: 1, cn: '一' },
    items: [{
      subject_id: 7,
      id: 7,
      type: 2,
      name: 'Prehydrated',
      images: {
        common: { hash, uri: `/image/${hash}`, r2_key: `images/${hash}/original` },
        large: null,
      },
      image_status: { common: 'cached', large: 'missing_source' },
    }],
  }])
  const response = await worker.fetch(new Request('https://read.local/calendar'), {
    AIRING_CAL_KV: kv,
    AIRING_CAL_R2: { get: async () => null },
    NSFW_SHOW: 'true',
  } as any)
  assert.equal(response.status, 200)
  const body = await response.json() as any
  assert.equal(body[0].items[0].images.common.hash, hash)
  assert.equal(kv.imageStatusGets.includes('image:status:7'), false)
})
