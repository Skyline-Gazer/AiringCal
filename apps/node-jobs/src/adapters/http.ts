import { fail, type JobErrorCode } from './errors.ts'
import type { RunContext } from './run-context.ts'

export async function postJson(
  run: RunContext,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  attempts: number,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    run.guard(timeoutMs + 1000)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([run.signal, AbortSignal.timeout(timeoutMs)]),
      })
      return response
    } catch (error) {
      lastError = error
      if (run.signal.aborted) fail('REQUEST_FAILED', undefined, { cause: error })
      if (attempt + 1 >= attempts) break
    }
  }
  fail('UPSTREAM_UNAVAILABLE', undefined, { cause: lastError })
}

export async function readJsonBody(response: Response, maxBytes: number): Promise<unknown> {
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > maxBytes) fail('D1_RESPONSE_INVALID', response.status)
  try {
    return JSON.parse(new TextDecoder().decode(buffer))
  } catch (error) {
    fail('D1_RESPONSE_INVALID', response.status, { cause: error })
  }
}

export function mapHttpFailure(code: JobErrorCode, status: number): never {
  fail(status >= 500 ? 'UPSTREAM_UNAVAILABLE' : code, status)
}
