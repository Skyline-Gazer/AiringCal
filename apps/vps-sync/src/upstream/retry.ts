import { BgmHttpError, BgmNetworkError, BgmTimeoutError } from '@airing-cal/bgm-api'

export type UpstreamErrorCategory = 'auth' | 'not_found' | 'rate_limited' | 'upstream' | 'timeout' | 'network' | 'contract'
export type UpstreamStage = 'config' | 'collections' | 'calendar' | 'complete'

export class UpstreamFetchError extends Error {
  constructor(
    readonly category: UpstreamErrorCategory,
    readonly code: string,
    readonly stage: UpstreamStage,
    readonly attempt: number,
  ) {
    super(`${category}:${code}:${stage}:${attempt}`)
    this.name = 'UpstreamFetchError'
  }
}

export interface RetryPolicy {
  stage: UpstreamStage
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
  random?: () => number
  now?: () => number
}

interface Classification {
  category: UpstreamErrorCategory
  code: string
  retry: boolean
  retryAfter?: string
}

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))

function errorRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function retryAfterFrom(error: unknown): string | undefined {
  const record = errorRecord(error)
  if (!record) return undefined
  if (typeof record.retryAfter === 'string') return record.retryAfter
  const headers = errorRecord(record.headers)
  if (headers && typeof headers.get === 'function') {
    try {
      const value = headers.get('retry-after')
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }
  const response = errorRecord(record.response)
  const responseHeaders = response && errorRecord(response.headers)
  if (responseHeaders && typeof responseHeaders.get === 'function') {
    try {
      const value = responseHeaders.get('retry-after')
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function classify(error: unknown): Classification {
  if (error instanceof BgmHttpError) {
    if (error.status === 401 || error.status === 403) {
      return {
        category: 'auth',
        code: error.status === 401 ? 'UPSTREAM_UNAUTHORIZED' : 'UPSTREAM_FORBIDDEN',
        retry: false,
      }
    }
    if (error.status === 404) return { category: 'not_found', code: 'UPSTREAM_NOT_FOUND', retry: false }
    if (error.status === 429) return { category: 'rate_limited', code: 'UPSTREAM_RATE_LIMITED', retry: true, retryAfter: retryAfterFrom(error) }
    if (error.status >= 500) return { category: 'upstream', code: 'UPSTREAM_5XX', retry: true, retryAfter: retryAfterFrom(error) }
    return { category: 'upstream', code: 'UPSTREAM_HTTP', retry: false }
  }
  if (error instanceof BgmTimeoutError) return { category: 'timeout', code: 'UPSTREAM_TIMEOUT', retry: true }
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { category: 'timeout', code: 'UPSTREAM_TIMEOUT', retry: true }
  }
  if (error instanceof BgmNetworkError || error instanceof TypeError) return { category: 'network', code: 'UPSTREAM_NETWORK', retry: true }
  return { category: 'contract', code: 'UPSTREAM_CONTRACT', retry: false }
}

function retryAfterDelay(value: string | undefined, now: number, maximum: number): number | null {
  if (!value || !value.trim()) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Math.min(maximum, Number(trimmed) * 1_000)
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(0, parsed - now)) : null
}

function fallbackDelay(attempt: number, base: number, maximum: number, random: () => number): number {
  const exponential = Math.min(maximum, base * 2 ** (attempt - 1))
  const sample = Math.min(1, Math.max(0, random()))
  return Math.min(maximum, Math.floor(exponential * (0.5 + sample)))
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, policy: RetryPolicy): Promise<T> {
  const maxAttempts = policy.maxAttempts ?? 3
  const baseDelayMs = policy.baseDelayMs ?? 250
  const maxDelayMs = policy.maxDelayMs ?? 10_000
  if (
    !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > 3
    || !Number.isFinite(baseDelayMs)
    || baseDelayMs < 0
    || !Number.isFinite(maxDelayMs)
    || maxDelayMs < 0
  ) {
    throw new UpstreamFetchError('contract', 'INVALID_RETRY_POLICY', policy.stage, 1)
  }

  const sleep = policy.sleep ?? defaultSleep
  const random = policy.random ?? Math.random
  const now = policy.now ?? Date.now
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      const result = classify(error)
      if (!result.retry || attempt === maxAttempts) {
        throw new UpstreamFetchError(result.category, result.code, policy.stage, attempt)
      }
      try {
        const delay = retryAfterDelay(result.retryAfter, now(), maxDelayMs) ?? fallbackDelay(attempt, baseDelayMs, maxDelayMs, random)
        await sleep(delay)
      } catch {
        throw new UpstreamFetchError('contract', 'RETRY_DELAY_FAILED', policy.stage, attempt)
      }
    }
  }
  throw new UpstreamFetchError('contract', 'UNREACHABLE_RETRY', policy.stage, maxAttempts)
}
