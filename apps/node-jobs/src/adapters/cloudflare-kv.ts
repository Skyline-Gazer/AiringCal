import type { NodeJobsConfig } from './env.ts'
import { fail } from './errors.ts'
import type { RunContext } from './run-context.ts'

export interface CloudflareKvClient {
  putJson(key: string, value: unknown): Promise<void>
  getJson(key: string): Promise<unknown | null>
}

export function createCloudflareKvClient(config: NodeJobsConfig, run: RunContext, timeoutMs = 20_000): CloudflareKvClient {
  if (!config.kvNamespaceId) fail('CONFIG_INVALID')
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/storage/kv/namespaces/${config.kvNamespaceId}/values`
  const headers = {
    Authorization: `Bearer ${config.cloudflareApiToken}`,
    'Content-Type': 'application/json',
  }

  async function call(method: 'GET' | 'PUT', key: string, body?: string): Promise<Response> {
    run.guard(timeoutMs + 1000)
    const encoded = encodeURIComponent(key)
    return fetch(`${base}/${encoded}`, {
      method,
      headers: method === 'PUT' ? headers : { Authorization: headers.Authorization },
      body,
      signal: AbortSignal.any([run.signal, AbortSignal.timeout(timeoutMs)]),
    })
  }

  return {
    async putJson(key, value) {
      const response = await call('PUT', key, JSON.stringify(value))
      if (!response.ok) {
        await response.body?.cancel()
        fail('KV_REQUEST_FAILED', response.status)
      }
    },
    async getJson(key) {
      const response = await call('GET', key)
      if (response.status === 404) return null
      if (!response.ok) {
        await response.body?.cancel()
        fail('KV_REQUEST_FAILED', response.status)
      }
      const text = await response.text()
      if (!text) return null
      try {
        return JSON.parse(text) as unknown
      } catch (error) {
        fail('KV_REQUEST_FAILED', response.status, { cause: error })
      }
    },
  }
}
