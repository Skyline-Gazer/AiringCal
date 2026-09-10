import type { RunResult } from '../contracts.ts'
import { buildFeishuMessage, signFeishu, type PreviousNotificationFailure } from './feishu.ts'

export type DeliveryClock = Readonly<{
  now(): number
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(timeout: unknown): void
}>

export type NotificationConfig = Readonly<{
  webhookUrl: string
  secret?: string
  timeoutMs: number
}>

type DeliveryIo = Readonly<{
  fetch: typeof globalThis.fetch
  clock: DeliveryClock
}>

const defaultIo: DeliveryIo = {
  fetch: globalThis.fetch,
  clock: { now: Date.now, setTimeout, clearTimeout: (timeout) => clearTimeout(timeout as ReturnType<typeof setTimeout>) },
}

function timeoutMilliseconds(value: number): number {
  return Number.isFinite(value) ? Math.min(30_000, Math.max(1, Math.trunc(value))) : 10_000
}

/** Delivers exactly one signed Feishu custom-bot message and converts every transport failure to a terminal result. */
export async function deliverNotification(
  config: NotificationConfig,
  result: RunResult,
  previousFailure?: PreviousNotificationFailure,
  io: DeliveryIo = defaultIo,
): Promise<'sent' | 'failed'> {
  const controller = new AbortController()
  let timedOut = false
  let timeoutHandle: unknown
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutHandle = io.clock.setTimeout(() => {
      timedOut = true
      controller.abort()
      resolve('timeout')
    }, timeoutMilliseconds(config.timeoutMs))
  })
  const timestamp = String(Math.floor(io.clock.now() / 1_000))
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.secret) {
    headers.Timestamp = timestamp
    headers.Sign = signFeishu(timestamp, config.secret)
  }
  try {
    const response = await Promise.race([
      io.fetch(config.webhookUrl, {
        method: 'POST', headers, body: JSON.stringify(buildFeishuMessage(result, previousFailure)), signal: controller.signal,
      }).catch(() => undefined),
      timeout,
    ])
    if (timedOut || response === 'timeout' || response === undefined || !response.ok) return 'failed'
    const body: unknown = await response.json().catch(() => undefined)
    return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === 0 ? 'sent' : 'failed'
  } catch {
    return 'failed'
  } finally {
    io.clock.clearTimeout(timeoutHandle)
  }
}
