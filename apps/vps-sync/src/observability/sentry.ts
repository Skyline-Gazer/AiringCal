import * as Sentry from '@sentry/node'
import { noOpTracing, runTracedOperationFailOpen, type TraceAttributes, type TraceSpanInput, type TracingPort } from './tracing.ts'

export interface SentrySdk {
  initWithoutDefaultIntegrations(options: {
    dsn: string
    tracesSampleRate: number
    sendDefaultPii: false
  }): unknown
  startSpan<T>(options: { name: string; attributes: TraceAttributes }, operation: (span: { setAttributes(attributes: TraceAttributes): unknown }) => T): T
  flush(timeout?: number): Promise<boolean>
}

export type SentryEnvironment = Readonly<{
  SENTRY_DSN?: string
  SENTRY_TRACES_SAMPLE_RATE?: string
}>

const flushTimeoutMs = 2_000

const nodeSdk: SentrySdk = {
  initWithoutDefaultIntegrations: Sentry.initWithoutDefaultIntegrations,
  startSpan: Sentry.startSpan,
  flush: Sentry.flush,
}

function sampleRate(value: string | undefined): number | undefined {
  if (value === undefined) return 1
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined
}

function spanOptions(input: TraceSpanInput): { name: string; attributes: TraceAttributes } {
  return { name: input.name, attributes: input.attributes }
}

async function flushFailOpen(sdk: SentrySdk): Promise<void> {
  const attempt = Promise.resolve().then(() => sdk.flush(flushTimeoutMs)).catch(() => undefined)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([attempt, new Promise<void>((resolve) => { timeout = setTimeout(resolve, flushTimeoutMs) })])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export function createSentryTracing(env: SentryEnvironment, sdk: SentrySdk = nodeSdk): TracingPort {
  const rate = sampleRate(env.SENTRY_TRACES_SAMPLE_RATE)
  if (!env.SENTRY_DSN || rate === undefined) return noOpTracing
  try {
    sdk.initWithoutDefaultIntegrations({ dsn: env.SENTRY_DSN, tracesSampleRate: rate, sendDefaultPii: false })
  } catch {
    return noOpTracing
  }
  return {
    async span<T>(input: TraceSpanInput, operation: () => Promise<T>): Promise<T> {
      return runTracedOperationFailOpen(operation, (executeBusiness) => sdk.startSpan(spanOptions(input), (span) => {
        void executeBusiness().then(
          () => { try { span.setAttributes(input.completeAttributes?.() ?? {}) } catch { /* Tracing must not change the run. */ } },
          () => { try { span.setAttributes(input.completeAttributes?.() ?? {}) } catch { /* Tracing must not change the run. */ } },
        )
        return executeBusiness()
      }))
    },
    flush: () => flushFailOpen(sdk),
  }
}

export function createNodeSentryTracing(env: SentryEnvironment): TracingPort {
  return createSentryTracing(env, nodeSdk)
}
