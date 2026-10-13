import assert from 'node:assert/strict'
import test from 'node:test'
import { imageOriginalKey, imageThumbV1Key } from '@airing-cal/storage'
import { authorizeThumbGen, handleThumbGenRequest } from './thumb-gen.ts'

const HASH = 'a'.repeat(64)

class MockR2 {
  objects = new Map<string, Uint8Array>()

  async head(key: string) {
    return this.objects.has(key) ? { key, size: this.objects.get(key)!.byteLength } : null
  }

  async get(key: string) {
    const bytes = this.objects.get(key)
    if (!bytes) return null
    return {
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      httpMetadata: { contentType: 'image/jpeg' },
    }
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.objects.set(key, bytes)
    return { key, size: bytes.byteLength }
  }
}

class MockImages {
  input(stream: ReadableStream<Uint8Array>) {
    const chain = {
      transform: () => chain,
      output: async () => ({
        image: () => new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0x52, 0x49, 0x46, 0x46]))
            controller.close()
          },
        }),
      }),
    }
    void stream
    return chain
  }
}

function env(r2 = new MockR2(), bearer = 'test-secret') {
  return {
    THUMB_GEN_BEARER: bearer,
    AIRING_CAL_R2: r2,
    IMAGES: new MockImages(),
  }
}

test('authorizeThumbGen rejects missing and wrong Bearer', () => {
  assert.equal(authorizeThumbGen(new Request('https://example.com/api/thumb-gen', { method: 'POST' }), { THUMB_GEN_BEARER: 'secret' }), false)
  assert.equal(
    authorizeThumbGen(
      new Request('https://example.com/api/thumb-gen', { headers: { Authorization: 'Bearer wrong' }, method: 'POST' }),
      { THUMB_GEN_BEARER: 'secret' },
    ),
    false,
  )
  assert.equal(
    authorizeThumbGen(
      new Request('https://example.com/api/thumb-gen', { headers: { Authorization: 'Bearer secret' }, method: 'POST' }),
      { THUMB_GEN_BEARER: 'secret' },
    ),
    true,
  )
})

test('POST /api/thumb-gen returns 401 without Bearer', async () => {
  const response = await handleThumbGenRequest(new Request('https://example.com/api/thumb-gen', { method: 'POST', body: '{}' }), env())
  assert.equal(response.status, 401)
})

test('POST /api/thumb-gen generates thumb when original exists', async () => {
  const r2 = new MockR2()
  r2.objects.set(imageOriginalKey(HASH), new Uint8Array([0xff, 0xd8, 0xff]))
  const response = await handleThumbGenRequest(
    new Request('https://example.com/api/thumb-gen', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ large_hashes: [HASH] }),
    }),
    env(r2),
  )
  const body = await response.json() as { summary: { generated: number } }
  assert.equal(response.status, 202)
  assert.equal(body.summary.generated, 1)
  assert.ok(r2.objects.has(imageThumbV1Key(HASH)))
})

test('POST /api/thumb-gen skips existing thumb', async () => {
  const r2 = new MockR2()
  r2.objects.set(imageOriginalKey(HASH), new Uint8Array([1, 2, 3]))
  r2.objects.set(imageThumbV1Key(HASH), new Uint8Array([9, 9]))
  const response = await handleThumbGenRequest(
    new Request('https://example.com/api/thumb-gen', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ large_hashes: [HASH] }),
    }),
    env(r2),
  )
  const body = await response.json() as { summary: { skipped: number } }
  assert.equal(body.summary.skipped, 1)
  assert.equal(r2.objects.get(imageThumbV1Key(HASH))!.length, 2)
})

test('POST /api/thumb-gen rejects batches over 50', async () => {
  const hashes = Array.from({ length: 51 }, (_, index) => String(index).padStart(64, '0'))
  const response = await handleThumbGenRequest(
    new Request('https://example.com/api/thumb-gen', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ large_hashes: hashes }),
    }),
    env(),
  )
  assert.equal(response.status, 400)
})
