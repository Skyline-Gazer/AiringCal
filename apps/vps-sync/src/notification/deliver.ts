import type { RunResult } from '../contracts.js'
import { buildFeishuMessage, signFeishu } from './feishu.js'

export { signFeishu }

export type NotificationDeliveryResult = 'sent' | 'failed'

export interface NotificationDeliveryConfig {
  webhookUrl: string
  token?: string
  secret?: string
  timeoutMs?: number
  now?: () => number
  fetch?: typeof globalThis.fetch
  logger?: (entry: { event: 'notification_failed'; reason: 'config' | 'timeout' | 'http' | 'response' | 'network' }) => void
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 60_000
const MAX_BODY_BYTES = 20 * 1024

function logFailure(config: NotificationDeliveryConfig, reason: NonNullable<Parameters<NonNullable<NotificationDeliveryConfig['logger']>>[0]>['reason']): void {
  try { config.logger?.({ event: 'notification_failed', reason }) } catch { /* logger is outside the delivery boundary */ }
}

function endpoint(config: NotificationDeliveryConfig): string {
  const url = new URL(config.webhookUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('NOTIFICATION_CONFIG')
  if (config.token !== undefined) {
    if (!config.token) throw new Error('NOTIFICATION_CONFIG')
    url.searchParams.set('key', config.token)
  }
  return url.href
}

function timestamp(now: () => number): string {
  const value = now()
  if (!Number.isFinite(value) || value < 0) throw new Error('NOTIFICATION_CONFIG')
  return String(Math.floor(value / 1_000))
}

function responseCode(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { code?: unknown }).code === 0
}

/** Delivers exactly one terminal Feishu request; transport/contract errors are reported as failed. */
export async function deliverNotification(
  config: NotificationDeliveryConfig,
  result: RunResult,
): Promise<NotificationDeliveryResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  try {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      logFailure(config, 'config')
      return 'failed'
    }
    const url = endpoint(config)
    const now = config.now ?? Date.now
    const signedTimestamp = timestamp(now)
    const message = buildFeishuMessage(result, result.previousNotificationFailure ?? undefined)
    const body = config.secret
      ? { ...message, timestamp: signedTimestamp, sign: signFeishu(signedTimestamp, config.secret) }
      : message
    const serializedBody = JSON.stringify(body)
    if (Buffer.byteLength(serializedBody, 'utf8') > MAX_BODY_BYTES) {
      logFailure(config, 'config')
      return 'failed'
    }
    const fetchImpl = config.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      logFailure(config, 'config')
      return 'failed'
    }

    controller = new AbortController()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort()
        reject(new Error('NOTIFICATION_TIMEOUT'))
      }, timeoutMs)
    })
    const request = fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: serializedBody,
      signal: controller.signal,
    })
    void request.catch(() => undefined)
    const response = await Promise.race([request, timeout])
    if (response.status < 200 || response.status >= 300) {
      logFailure(config, 'http')
      return 'failed'
    }
    let payload: unknown
    try {
      const bodyPromise = response.json()
      void bodyPromise.catch(() => undefined)
      payload = await Promise.race([bodyPromise, timeout])
    } catch (error) {
      if (error instanceof Error && error.message === 'NOTIFICATION_TIMEOUT') throw error
      logFailure(config, 'response')
      return 'failed'
    }
    if (!responseCode(payload)) {
      logFailure(config, 'response')
      return 'failed'
    }
    return 'sent'
  } catch (error) {
    logFailure(config, error instanceof Error && error.message === 'NOTIFICATION_TIMEOUT' ? 'timeout' : 'network')
    return 'failed'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller?.abort()
  }
}
