export interface ObjectHead {
  etag: string
  contentType?: string
  size?: number
}
export interface ObjectGet extends ObjectHead {
  body: Uint8Array
}

export interface ObjectPutOptions {
  contentType?: string
  /** Quoted or unquoted etag; store normalizes comparison. */
  ifMatch?: string
  /** Use `*` to require the key be absent. */
  ifNoneMatch?: string
}

export class ObjectStorePreconditionError extends Error {
  constructor(message = 'Object store precondition failed') {
    super(message)
    this.name = 'ObjectStorePreconditionError'
  }
}

/** Minimal S3-like object API used by checkpoint + Node PublicStore. */
export interface ConditionalObjectStore {
  get(key: string): Promise<ObjectGet | null>
  head(key: string): Promise<ObjectHead | null>
  put(key: string, body: Uint8Array, options?: ObjectPutOptions): Promise<ObjectHead>
  delete?(key: string): Promise<void>
}

export function normalizeEtag(etag: string): string {
  const trimmed = etag.trim()
  if (trimmed.startsWith('W/')) return normalizeEtag(trimmed.slice(2))
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

export function quoteEtag(etag: string): string {
  const raw = normalizeEtag(etag)
  return `"${raw}"`
}
