import { canonicalJson } from '@airing-cal/storage'
import {
  PUBLIC_RELEASE_POINTER_KEY,
  bytesEqual,
  parsePublicReleasePointer,
  releasePointersMatch,
} from '@airing-cal/v3-core/public-pointer'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'
import {
  ObjectStorePreconditionError,
  type ConditionalObjectStore,
} from './object-store.ts'

function assertSafeObjectKey(key: string): void {
  if (key.includes('\0') || key.startsWith('/') || key.includes('\\') || key.split('/').includes('..')) {
    throw new Error(`Unsafe public store object key: ${key}`)
  }
}

/** Node/S3-API PublicStore (R2 day one; any S3-compatible endpoint later). */
export class S3CompatiblePublicStore implements PublicStore {
  constructor(
    readonly objects: ConditionalObjectStore,
    readonly pointerKey: string = PUBLIC_RELEASE_POINTER_KEY,
  ) {}

  async getCurrentRelease(): Promise<PublicReleasePointer | null> {
    assertSafeObjectKey(this.pointerKey)
    const object = await this.objects.get(this.pointerKey)
    if (!object) return null
    return parsePublicReleasePointer(new TextDecoder().decode(object.body))
  }

  async getSnapshotBytes(artifactRef: string): Promise<Uint8Array | null> {
    assertSafeObjectKey(artifactRef)
    const object = await this.objects.get(artifactRef)
    return object ? object.body : null
  }
  async headObject(key: string): Promise<{ size: number; etag: string | null } | null> {
    assertSafeObjectKey(key)
    const head = await this.objects.head(key)
    if (!head) return null
    return { size: head.size ?? 0, etag: head.etag }
  }

  async putImmutableObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    assertSafeObjectKey(key)
    const head = await this.objects.head(key)
    if (head) {
      const existing = await this.getSnapshotBytes(key)
      if (!existing || !bytesEqual(existing, body)) {
        throw new Error(`Immutable object already exists with different bytes: ${key}`)
      }
      return
    }
    try {
      await this.objects.put(key, body, { contentType, ifNoneMatch: '*' })
    } catch (error) {
      if (!(error instanceof ObjectStorePreconditionError)) throw error
      const existing = await this.getSnapshotBytes(key)
      if (!existing || !bytesEqual(existing, body)) {
        throw new Error(`Immutable object already exists with different bytes: ${key}`)
      }
    }
  }

  async commitRelease(
    expected: PublicReleasePointer | null,
    next: PublicReleasePointer,
  ): Promise<'committed' | 'conflict' | 'unsupported'> {
    assertSafeObjectKey(this.pointerKey)
    const current = await this.getCurrentRelease()
    if (!releasePointersMatch(expected, current)) return 'conflict'

    const head = await this.objects.head(this.pointerKey)
    const body = new TextEncoder().encode(`${canonicalJson(next)}\n`)
    try {
      if (head) {
        await this.objects.put(this.pointerKey, body, {
          contentType: 'application/json',
          ifMatch: head.etag,
        })
      } else {
        await this.objects.put(this.pointerKey, body, {
          contentType: 'application/json',
          ifNoneMatch: '*',
        })
      }
    } catch (error) {
      if (!(error instanceof ObjectStorePreconditionError)) {
        console.warn(
          `S3 pointer put failed for ${this.pointerKey}; verifying pointer state`,
          error instanceof Error ? error.message : error,
        )
      }
      const after = await this.getCurrentRelease()
      if (releasePointersMatch(next, after)) return 'committed'
      return 'conflict'
    }

    const after = await this.getCurrentRelease()
    if (releasePointersMatch(next, after)) return 'committed'
    return 'conflict'
  }
}
