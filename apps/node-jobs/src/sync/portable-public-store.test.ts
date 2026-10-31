import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FilesystemPublicStore, MemoryPublicStore } from '@airing-cal/v3-core'
import { S3CompatiblePublicStore } from '../adapters/s3-public-store.ts'
import { createPortablePublicStoreFromEnv, type ClosablePublicStore } from './portable-public-store.ts'

test('createPortablePublicStoreFromEnv prefers S3 when configured', () => {
  const store: ClosablePublicStore = createPortablePublicStoreFromEnv({
    AIRINGCAL_PUBLIC_S3_ENDPOINT: 'https://PLACEHOLDER_ACCOUNT_ID.r2.cloudflarestorage.com',
    AIRINGCAL_PUBLIC_S3_BUCKET: 'PLACEHOLDER_PUBLIC_BUCKET',
    AIRINGCAL_PUBLIC_S3_ACCESS_KEY_ID: 'PLACEHOLDER_PUBLIC_ACCESS_KEY_ID',
    AIRINGCAL_PUBLIC_S3_SECRET_ACCESS_KEY: 'PLACEHOLDER_PUBLIC_SECRET_ACCESS_KEY',
    AIRINGCAL_BUILDER_PUBLIC_DIR: '/tmp/should-not-use',
  })
  assert.equal(typeof store.close, 'function')
  store.close?.()
  assert.ok(store instanceof S3CompatiblePublicStore)
})

test('createPortablePublicStoreFromEnv uses filesystem when only PUBLIC_DIR set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-pub-'))
  try {
    const store = createPortablePublicStoreFromEnv({
      AIRINGCAL_BUILDER_PUBLIC_DIR: dir,
    })
    assert.ok(store instanceof FilesystemPublicStore)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createPortablePublicStoreFromEnv falls back to memory', () => {
  const store = createPortablePublicStoreFromEnv({})
  assert.ok(store instanceof MemoryPublicStore)
})
