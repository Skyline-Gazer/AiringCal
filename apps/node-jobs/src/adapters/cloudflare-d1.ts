import type { NodeJobsConfig } from './env.ts'
import { fail } from './errors.ts'
import { postJson, readJsonBody } from './http.ts'
import type { RunContext } from './run-context.ts'

export type D1Row = Record<string, unknown>

export interface CloudflareD1Client {
  query(sql: string, params?: unknown[]): Promise<D1Row[]>
  export(body: Record<string, unknown>): Promise<unknown>
}

export function createCloudflareD1Client(config: NodeJobsConfig, run: RunContext): CloudflareD1Client {
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/d1/database/${config.d1DatabaseId}`
  const headers = {
    Authorization: `Bearer ${config.cloudflareApiToken}`,
    'Content-Type': 'application/json',
  }

  async function call(operation: string, body: Record<string, unknown>, attempts: number): Promise<unknown> {
    const response = await postJson(run, `${base}/${operation}`, headers, body, attempts, 20_000)
    if (!response.ok) {
      await response.body?.cancel()
      fail('D1_REQUEST_FAILED', response.status)
    }
    const data = await readJsonBody(response, 16 * 1024 * 1024) as {
      success?: boolean
      result?: unknown
      errors?: Array<{ code?: number }>
    }
    if (data.success !== true) {
      const codes = Array.isArray(data.errors)
        ? data.errors.map((item) => item?.code).filter((code): code is number => Number.isSafeInteger(code)).slice(0, 10)
        : []
      console.error(JSON.stringify({ status: 'error', stage: `d1_${operation}`, http_status: response.status, upstream_error_codes: codes }))
      fail('D1_REQUEST_FAILED', response.status)
    }
    return data.result
  }

  return {
    async query(sql, params = []) {
      const result = await call('query', { sql, params: params.map(String) }, 3)
      if (!Array.isArray(result) || result.length !== 1) fail('D1_RESPONSE_INVALID')
      const first = result[0] as { success?: boolean; results?: D1Row[] }
      if (first.success !== true || !Array.isArray(first.results)) fail('D1_RESPONSE_INVALID')
      return first.results
    },
    export(body) {
      const attempts = body.current_bookmark ? 3 : 1
      return call('export', body, attempts)
    },
  }
}
