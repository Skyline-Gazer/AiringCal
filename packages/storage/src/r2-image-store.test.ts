import assert from 'node:assert/strict'
import test from 'node:test'
import { R2ImageStore } from './index.ts'

class MockR2Bucket {
  writes: Array<{ key: string; value: ArrayBuffer; options: any }> = []
  objects = new Map<string, { value: ArrayBuffer; options: any }>()

  async put(key: string, value: ArrayBuffer, options: any) {
    this.writes.push({ key, value, options })
    this.objects.set(key, { value, options })
    return {}
  }

  async get(key: string) {
    const stored = this.objects.get(key)
    if (!stored) return null
    return {
      arrayBuffer: async () => stored.value,
      httpMetadata: stored.options.httpMetadata,
      customMetadata: stored.options.customMetadata,
    }
  }
}

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer
}

test('R2ImageStore writes original image bytes with reusable metadata', async () => {
  const bucket = new MockR2Bucket()
  const store = new R2ImageStore(bucket)
  const hash = 'b'.repeat(64)
  const cachedAt = 1782650000

  await store.putOriginal(hash, bytes('image'), 'image/webp', {
    sourceUrl: 'https://lain.example/image.webp',
    subjectId: 23080,
    sourceSize: 'common',
    cachedAt,
  })

  assert.equal(bucket.writes[0].key, `images/${hash}/original`)
  assert.deepEqual(bucket.writes[0].options.httpMetadata, { contentType: 'image/webp' })
  assert.deepEqual(bucket.writes[0].options.customMetadata, {
    bytes: '5',
    source_url: 'https://lain.example/image.webp',
    subject_id: '23080',
    source_size: 'common',
    cached_at: String(cachedAt),
  })
})

test('R2ImageStore reads original image metadata back from R2', async () => {
  const bucket = new MockR2Bucket()
  const store = new R2ImageStore(bucket)
  const hash = 'c'.repeat(64)

  await store.putOriginal(hash, bytes('image'), 'image/png', {
    sourceUrl: 'https://lain.example/image.png',
    subjectId: 42,
    sourceSize: 'large',
    cachedAt: 1782650300,
  })

  const stored = await store.getOriginal(hash)

  assert.equal(stored?.contentType, 'image/png')
  assert.equal(stored?.bytes, 5)
  assert.equal(stored?.sourceUrl, 'https://lain.example/image.png')
  assert.equal(stored?.subjectId, 42)
  assert.equal(stored?.sourceSize, 'large')
  assert.equal(stored?.cachedAt, 1782650300)
})
