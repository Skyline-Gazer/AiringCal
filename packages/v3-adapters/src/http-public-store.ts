import { parsePublicReleasePointer } from '@airing-cal/v3-core/public-pointer'
import { parsePublicBaseUrl } from '@airing-cal/v3-core/public-image-url'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'

export interface HttpPublicStoreOptions {
  /** Pointer object key (default `public/current-release.json`), matching the other stores. */
  pointerKey?: string
  /**
   * Custom fetch (tests / platform runtimes without `globalThis.fetch`).
   * Defaults to the ambient `fetch`.
   */
  fetch?: typeof fetch
}

/**
 * Read-only `PublicStore` over HTTP/CDN: every object is fetched from the public
 * base URL that fronts the published Release (R2/S3 public bucket + CDN).
 *
 * Blob (EdgeOne Makers) is **not** a publish authority: the GHA writer publishes
 * the Release into a CAS-capable store (R2/S3) and readers fetch it over HTTPS.
 * This adapter therefore implements reads only — `putImmutableObject` throws and
 * `commitRelease` reports `unsupported` so nothing can ever publish through it.
 */
export class HttpPublicStore implements PublicStore {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  /** Isolate-lifetime memo: once HEAD is 405/501, skip HEAD and use GET. */
  private headSupported: boolean | null = null

  constructor(
    publicBaseUrl: string,
    readonly pointerKey: string = 'public/current-release.json',
    options: HttpPublicStoreOptions = {},
  ) {
    // Same validation as the read handlers; `allowInsecure` keeps MinIO-style
    // local adapters possible while every deployed surface requires https.
    this.baseUrl = parsePublicBaseUrl(publicBaseUrl, { allowInsecure: true })!
    this.fetchImpl = options.fetch ?? fetch
  }

  private objectUrl(key: string): string {
    const segments = key.split('/')
    if (segments.includes('..') || segments.includes('.') || segments.some((part) => part === '')) {
      throw new Error(`Refusing to fetch a non-object key over HTTP: ${key}`)
    }
    return `${this.baseUrl}/${segments.map(encodeURIComponent).join('/')}`
  }

  private async getBytes(key: string): Promise<{ bytes: Uint8Array; text: string } | null> {
    const response = await this.fetchImpl(this.objectUrl(key), {
      headers: { 'cache-control': 'no-cache' },
    })
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching public object ${key}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { bytes, text: new TextDecoder().decode(bytes) }
  }

  private headFromResponse(response: Response, key: string): {
    size: number
    etag: string | null
    contentType?: string | null
  } {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} heading public object ${key}`)
    }
    const lengthHeader = response.headers.get('content-length')
    const size = lengthHeader != null && lengthHeader !== '' ? Number(lengthHeader) : 0
    return {
      size: Number.isFinite(size) ? size : 0,
      etag: response.headers.get('etag'),
      contentType: response.headers.get('content-type'),
    }
  }

  private async headViaGet(key: string): Promise<{
    size: number
    etag: string | null
    contentType?: string | null
  } | null> {
    const response = await this.fetchImpl(this.objectUrl(key), {
      method: 'GET',
      headers: { 'cache-control': 'no-cache' },
    })
    if (response.status === 404) return null
    // Drain body so the underlying connection can be reused; existence/metadata only.
    await response.arrayBuffer().catch(() => undefined)
    return this.headFromResponse(response, key)
  }

  async headObject(
    key: string,
  ): Promise<{ size: number; etag: string | null; contentType?: string | null } | null> {
    if (this.headSupported === false) {
      return this.headViaGet(key)
    }

    const response = await this.fetchImpl(this.objectUrl(key), {
      method: 'HEAD',
      headers: { 'cache-control': 'no-cache' },
    })

    if (response.status === 405 || response.status === 501) {
      this.headSupported = false
      return this.headViaGet(key)
    }

    this.headSupported = true
    if (response.status === 404) return null
    return this.headFromResponse(response, key)
  }

  async getCurrentRelease(): Promise<PublicReleasePointer | null> {
    const body = await this.getBytes(this.pointerKey)
    if (!body) return null
    try {
      return parsePublicReleasePointer(body.text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid public release pointer at ${this.pointerKey}: ${reason}`)
    }
  }

  async getSnapshotBytes(artifactRef: string): Promise<Uint8Array | null> {
    const body = await this.getBytes(artifactRef)
    return body?.bytes ?? null
  }

  async putImmutableObject(
    _key: string,
    _body: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    throw new Error('HttpPublicStore is read-only; publishing goes through a CAS-capable PublicStore')
  }

  async commitRelease(
    _expected: PublicReleasePointer | null,
    _next: PublicReleasePointer,
  ): Promise<'committed' | 'conflict' | 'unsupported'> {
    return 'unsupported'
  }
}
