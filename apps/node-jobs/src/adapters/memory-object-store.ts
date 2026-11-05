import { createHash } from 'node:crypto'
import {
  ObjectStorePreconditionError,
  normalizeEtag,
  quoteEtag,
  type ConditionalObjectStore,
  type ObjectGet,
  type ObjectHead,
  type ObjectPutOptions,
} from './object-store.ts'

interface Entry {
  body: Uint8Array
  etag: string
  contentType?: string
}

function etagFor(body: Uint8Array): string {
  return quoteEtag(createHash('sha256').update(body).digest('hex'))
}

export class MemoryObjectStore implements ConditionalObjectStore {
  private readonly objects = new Map<string, Entry>()

  async get(key: string): Promise<ObjectGet | null> {
    const entry = this.objects.get(key)
    if (!entry) return null
    return {
      body: new Uint8Array(entry.body),
      etag: entry.etag,
      contentType: entry.contentType,
      size: entry.body.byteLength,
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const entry = this.objects.get(key)
    if (!entry) return null
    return { etag: entry.etag, contentType: entry.contentType }
  }

  async put(key: string, body: Uint8Array, options: ObjectPutOptions = {}): Promise<ObjectHead> {
    const existing = this.objects.get(key)
    if (options.ifNoneMatch === '*') {
      if (existing) throw new ObjectStorePreconditionError(`If-None-Match * failed for ${key}`)
    }
    if (options.ifMatch !== undefined) {
      if (!existing || normalizeEtag(existing.etag) !== normalizeEtag(options.ifMatch)) {
        throw new ObjectStorePreconditionError(`If-Match failed for ${key}`)
      }
    }
    const copy = new Uint8Array(body)
    const entry: Entry = {
      body: copy,
      etag: etagFor(copy),
      contentType: options.contentType,
    }
    this.objects.set(key, entry)
    return { etag: entry.etag, contentType: entry.contentType }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}
