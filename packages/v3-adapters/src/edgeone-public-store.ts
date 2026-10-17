import {
  PUBLIC_RELEASE_POINTER_KEY,
  bytesEqual,
  parsePublicReleasePointer,
  releasePointersMatch,
} from '@airing-cal/v3-core/public-pointer'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'

export interface EdgeOneBlobGetOptions {
  type?: 'text' | 'json' | 'arrayBuffer'
  consistency?: 'eventual' | 'strong'
}

export interface EdgeOneBlobListResult {
  blobs: Array<{ key: string; etag: string }>
  cursor?: string
}

/**
 * Minimal EdgeOne Makers Blob surface (`@edgeone/pages-blob` store) the v3
 * public store needs. Verified against the EdgeOne Blob documentation
 * (2026-10-17): `get`, `getWithHeaders` (etag + content-type), `set`,
 * `list({ prefix, paginate, cursor })` and `delete`.
 *
 * Keys keep the same layout as the filesystem/R2 stores (`snapshots/v1/…`,
 * `public/current-release.json`, `images/<hash>/original`); values are read as
 * `arrayBuffer`/`text` so the store is content-type agnostic.
 */
export interface EdgeOneBlobBinding {
  get(key: string, options?: EdgeOneBlobGetOptions): Promise<unknown>
  getWithHeaders(
    key: string,
    options?: EdgeOneBlobGetOptions,
  ): Promise<{ body: string; headers: Record<string, string> } | null>
  set(key: string, value: string | ArrayBuffer): Promise<void>
  list(options?: { prefix?: string; paginate?: boolean; cursor?: string }): Promise<EdgeOneBlobListResult>
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer
}

function toBytes(value: unknown, what: string): Uint8Array | null {
  if (value === null || value === undefined) return null
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  }
  if (typeof value === 'string') return new TextEncoder().encode(value)
  throw new Error(`EdgeOne Blob ${what} returned an unsupported value type`)
}

export class EdgeOnePublicStore implements PublicStore {
  constructor(
    readonly store: EdgeOneBlobBinding,
    readonly pointerKey: string = PUBLIC_RELEASE_POINTER_KEY,
  ) {}

  private async readBytes(key: string): Promise<Uint8Array | null> {
    return toBytes(await this.store.get(key, { type: 'arrayBuffer' }), key)
  }

  async getCurrentRelease(): Promise<PublicReleasePointer | null> {
    const raw = await this.store.get(this.pointerKey, { type: 'text' })
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'string') throw new Error('EdgeOne Blob release pointer is not text')
    return parsePublicReleasePointer(raw)
  }

  async getSnapshotBytes(artifactRef: string): Promise<Uint8Array | null> {
    return this.readBytes(artifactRef)
  }

  /**
   * Immutability is enforced by read-then-write plus a read-back check: EdgeOne
   * Blob `set` overwrites unconditionally and exposes no conditional write, so
   * two concurrent publishers could race. Publishing therefore stays a
   * single-publisher operation (`EdgeOneRuntimeAdapter.compare_and_swap_pointer`
   * is `false`).
   */
  async putImmutableObject(key: string, body: Uint8Array, _contentType: string): Promise<void> {
    const existing = await this.readBytes(key)
    if (existing) {
      if (!bytesEqual(existing, body)) {
        throw new Error(`Immutable object already exists with different bytes: ${key}`)
      }
      return
    }
    await this.store.set(key, bytesToArrayBuffer(body))
    const readback = await this.readBytes(key)
    if (!readback || !bytesEqual(readback, body)) {
      throw new Error(`EdgeOne Blob read-back mismatch after writing ${key}`)
    }
  }

  /**
   * EdgeOne Blob has no conditional write (no `If-Match`/etag precondition on
   * `set`), so an atomic pointer swap cannot be guaranteed: publishing reports
   * `unsupported` and the release pointer has to move through a store that
   * supports CAS (R2/`CloudflareR2PublicStore`) or a single-writer path.
   */
  async commitRelease(
    expected: PublicReleasePointer | null,
    next: PublicReleasePointer,
  ): Promise<'committed' | 'conflict' | 'unsupported'> {
    const current = await this.getCurrentRelease()
    if (!releasePointersMatch(expected, current)) return 'conflict'
    return 'unsupported'
  }

  /** Lists object keys under `prefix`, following the Blob `cursor` to the end. */
  async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await this.store.list(
        cursor === undefined ? { prefix, paginate: false } : { prefix, paginate: false, cursor },
      )
      for (const blob of page.blobs) keys.push(blob.key)
      if (!page.cursor) return keys
      if (page.cursor === cursor) throw new Error(`EdgeOne Blob list repeated cursor ${page.cursor}`)
      cursor = page.cursor
    }
  }
}
