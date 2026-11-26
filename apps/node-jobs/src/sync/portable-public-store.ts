import { mkdirSync } from 'node:fs'
import { FilesystemPublicStore, MemoryPublicStore, type PublicStore } from '@airing-cal/v3-core'
import { readPublicS3Config } from '../adapters/s3-env.ts'
import { createS3ObjectStore } from '../adapters/s3-object-store.ts'
import { S3CompatiblePublicStore } from '../adapters/s3-public-store.ts'

export type ClosablePublicStore = PublicStore & { close?: () => void }

/** Select portable publish target: S3 (preferred) → filesystem → memory. */
export function createPortablePublicStoreFromEnv(
  env: Record<string, string | undefined>,
): ClosablePublicStore {
  const s3 = readPublicS3Config(env)
  if (s3) {
    const objects = createS3ObjectStore(s3)
    const store = new S3CompatiblePublicStore(objects)
    return Object.assign(store, { close: () => objects.close() })
  }
  const publicDir = env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim()
  if (publicDir) {
    mkdirSync(publicDir, { recursive: true })
    return new FilesystemPublicStore(publicDir)
  }
  return new MemoryPublicStore()
}
