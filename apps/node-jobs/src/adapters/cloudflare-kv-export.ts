/**
 * Read-only export of the legacy v2 KV entries that the #73 migration imports.
 *
 * Contract verified against the Cloudflare API reference (2026-10-17):
 * - list keys: `GET /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys`
 *   with `prefix`, `limit` (10..1000) and `cursor` (`result_info.cursor`);
 * - bulk values: `POST .../namespaces/{namespace_id}/bulk/get` with
 *   `{ keys: [...], type: 'json' }`, maximum 100 keys per request;
 * - auth: `Authorization: Bearer <token>`.
 */

/** Legacy KV key prefixes the migration reads (`packages/storage/src/legacy-migration.ts`). */
export const LEGACY_KV_KEY_PREFIXES = [
  'subject:detail:',
  'subject:meta:',
  'image:status:',
  'subject:refresh:',
] as const

export const KV_LIST_KEYS_MAX_LIMIT = 1000
export const KV_BULK_GET_MAX_KEYS = 100

export interface CloudflareKvExportOptions {
  accountId: string
  namespaceId: string
  apiToken: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  pageLimit?: number
}

export interface LegacyKvExport {
  entries: Record<string, unknown>
  keyCount: number
  prefixes: Record<string, number>
}

function assertRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Cloudflare KV ${what} is not an object`)
  }
  return value as Record<string, unknown>
}

/** Cloudflare error entries are `{ code, message }`; anything else contributes no text. */
function errorMessage(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null || !('message' in entry)) return ''
  return typeof entry.message === 'string' ? entry.message : ''
}

export class CloudflareKvExportClient {
  readonly accountId: string
  readonly namespaceId: string
  readonly apiToken: string
  readonly baseUrl: string
  readonly pageLimit: number
  private readonly fetchImpl: typeof fetch
  constructor(options: CloudflareKvExportOptions) {
    if (!options.accountId) throw new Error('Cloudflare account id is required')
    if (!options.namespaceId) throw new Error('Cloudflare KV namespace id is required')
    if (!options.apiToken) throw new Error('Cloudflare API token is required')
    const pageLimit = options.pageLimit ?? KV_LIST_KEYS_MAX_LIMIT
    if (!Number.isInteger(pageLimit) || pageLimit < 10 || pageLimit > KV_LIST_KEYS_MAX_LIMIT) {
      throw new Error(`KV list page limit must be an integer between 10 and ${KV_LIST_KEYS_MAX_LIMIT}`)
    }
    this.accountId = options.accountId
    this.namespaceId = options.namespaceId
    this.apiToken = options.apiToken
    this.baseUrl = options.baseUrl ?? 'https://api.cloudflare.com/client/v4'
    this.pageLimit = pageLimit
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private get namespacePath(): string {
    return `${this.baseUrl}/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`
  }

  private async requestJson(init: RequestInit & { url: string }, what: string): Promise<Record<string, unknown>> {
    const { url, ...rest } = init
    const response = await this.fetchImpl(url, {
      ...rest,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(rest.headers as Record<string, string> | undefined),
      },
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      throw new Error(`Cloudflare KV ${what} returned non-JSON (${response.status})`)
    }
    const body = assertRecord(payload, `${what} response`)
    if (!response.ok || body.success === false) {
      const errors = Array.isArray(body.errors) ? body.errors : []
      const message = errors
        .map(errorMessage)
        .filter(Boolean)
        .join('; ')
      throw new Error(`Cloudflare KV ${what} failed (${response.status})${message ? `: ${message}` : ''}`)
    }
    return body
  }

  /** Lists every key under `prefix`, following `result_info.cursor` to the end. */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    for (;;) {
      const url = new URL(`${this.namespacePath}/keys`)
      url.searchParams.set('prefix', prefix)
      url.searchParams.set('limit', String(this.pageLimit))
      if (cursor !== undefined) url.searchParams.set('cursor', cursor)
      const body = await this.requestJson({ url: url.toString() }, `keys list (${prefix})`)

      const result = body.result
      if (!Array.isArray(result)) throw new Error(`Cloudflare KV keys list (${prefix}) result is not an array`)
      for (const entry of result) {
        const key = assertRecord(entry, `key entry (${prefix})`).name
        if (typeof key !== 'string' || key.length === 0) throw new Error(`Cloudflare KV key entry is not a named key (${prefix})`)
        keys.push(key)
      }

      const cursorInfo = body.result_info === undefined ? undefined : assertRecord(body.result_info, 'result_info')
      const next = cursorInfo?.cursor
      if (next === undefined || next === null || next === '') return keys
      if (typeof next !== 'string') throw new Error('Cloudflare KV result_info.cursor is not a string')
      if (next === cursor) throw new Error(`Cloudflare KV keys list (${prefix}) repeated cursor ${next}`)
      cursor = next
    }
  }

  /** Values for `keys` (≤100 per request), returned as `{ key: value }`. */
  async getValues(keys: string[]): Promise<Record<string, unknown>> {
    const values: Record<string, unknown> = {}
    for (let offset = 0; offset < keys.length; offset += KV_BULK_GET_MAX_KEYS) {
      const chunk = keys.slice(offset, offset + KV_BULK_GET_MAX_KEYS)
      const body = await this.requestJson({
        url: `${this.namespacePath}/bulk/get`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: chunk, type: 'json' }),
      }, `bulk get (${chunk.length} keys)`)
      const result = assertRecord(body.result, 'bulk get result')
      const chunkValues = assertRecord(result.values, 'bulk get values')
      for (const key of chunk) {
        if (Object.hasOwn(chunkValues, key)) values[key] = chunkValues[key]
      }
    }
    return values
  }

  /** Lists and reads every legacy KV entry the #73 import consumes. */
  async exportLegacyEntries(prefixes: readonly string[] = LEGACY_KV_KEY_PREFIXES): Promise<LegacyKvExport> {
    const entries: Record<string, unknown> = {}
    const counts: Record<string, number> = {}
    for (const prefix of prefixes) {
      const keys = await this.listKeys(prefix)
      counts[prefix] = keys.length
      if (keys.length === 0) continue
      Object.assign(entries, await this.getValues(keys))
    }
    return { entries, keyCount: Object.keys(entries).length, prefixes: counts }
  }
}
