import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { imageOriginalKey, imageThumbV2Key } from '@airing-cal/storage'
import sharp from 'sharp'
import type { R2Store } from '../adapters/r2-store.ts'
import { materializePortableThumbs } from './portable-thumb.ts'

class MemoryR2 implements R2Store {
  objects = new Map<string, Uint8Array>()

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body)
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null
  }

  async verifiedPut(key: string, bytes: Uint8Array): Promise<void> {
    await this.put(key, bytes)
  }

  close(): void {}
}

test('materializePortableThumbs writes thumb.v2.webp from original bytes', async () => {
  const original = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer()
  const store = new MemoryR2()
  const hash = createHash('sha256').update(original).digest('hex')
  await store.put(imageOriginalKey(hash), new Uint8Array(original))
  const summary = await materializePortableThumbs([hash], store)
  assert.equal(summary.generated, 1)
  assert.ok(store.objects.has(imageThumbV2Key(hash)))
})
