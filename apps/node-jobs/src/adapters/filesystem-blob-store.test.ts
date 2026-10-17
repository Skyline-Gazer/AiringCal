import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFilesystemBlobStore } from './filesystem-blob-store.ts'

test('createFilesystemBlobStore writes immutable blobs under root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-blobs-'))
  const store = createFilesystemBlobStore(root)
  const body = Uint8Array.from([1, 2, 3])
  await store.put('images/aa/original', body, 'image/jpeg')
  const readback = await store.get('images/aa/original')
  assert.equal(readback?.byteLength, body.byteLength)
  assert.equal(readback?.[0], 1)
  store.close()
})
