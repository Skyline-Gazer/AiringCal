import { createHmac } from 'node:crypto'
import type { RunResult } from '../contracts.js'
import { redactText } from './redact.js'

export type FeishuMessage = Readonly<{ msg_type: 'text'; content: Readonly<{ text: string }> }>
export type PreviousNotificationFailure = Readonly<{ category: string; code: string; stage: string }>

/** Feishu custom bot signs an empty body with HMAC-SHA256(timestamp + newline + secret). */
export function signFeishu(timestamp: string, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

const COUNT_FIELDS = ['users', 'collections', 'inserted', 'updated', 'unchanged', 'missing', 'deleted', 'mediaSelected', 'mediaSucceeded', 'mediaFailed'] as const
const DURATION_FIELDS = ['fetch', 'collection', 'calendar', 'state', 'completeState', 'media', 'publication', 'backup', 'notification'] as const
const CATEGORIES = new Set([
  'auth', 'not_found', 'rate_limited', 'upstream', 'timeout', 'network', 'contract', 'runtime', 'database', 'media', 'publication', 'backup', 'notification', 'lock', 'unknown',
])
const CODES = new Set([
  'UNKNOWN', 'UPSTREAM_UNAUTHORIZED', 'UPSTREAM_FORBIDDEN', 'UPSTREAM_NOT_FOUND', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_5XX', 'UPSTREAM_HTTP', 'UPSTREAM_TIMEOUT', 'UPSTREAM_NETWORK', 'UPSTREAM_CONTRACT',
  'UPSTREAM_AUTH', 'UPSTREAM_RATE_LIMIT', 'UPSTREAM_SERVER', 'INVALID_RETRY_POLICY', 'RETRY_DELAY_FAILED', 'UNREACHABLE_RETRY', 'STAGE_FAILED', 'MEDIA_INVALID', 'MEDIA_UPLOAD', 'PUBLICATION', 'BACKUP', 'NOTIFICATION', 'NOTIFICATION_FAILED', 'DATABASE', 'LOCK_UNAVAILABLE',
])
const STAGES = new Set([
  'config', 'collections', 'calendar', 'complete', 'lock', 'collection', 'completeState', 'fetch', 'state', 'media', 'publication', 'backup', 'notification', 'finished', 'unknown',
])

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function safeText(value: unknown, fallback = 'unknown'): string {
  if (value === null || value === undefined) return fallback
  const text = redactText(typeof value === 'string' ? value : String(value))
  return text || fallback
}

function canonical(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown'
}

function errorSummary(error: { category: string; code: string; stage: string }, attemptCount?: unknown): string {
  const summary = `${canonical(error.category, CATEGORIES)}/${canonical(error.code, CODES)}/${canonical(error.stage, STAGES)}`
  return attemptCount === undefined ? summary : `${summary}/attempt=${count(attemptCount)}`
}

function safeHash(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : 'none'
}

function safeGeneration(value: unknown): number | 'none' {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 'none'
}

function localTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'invalid' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false,
  }).format(date)
}

function publicationSummary(result: RunResult): { generation: number | 'none'; hash: string } {
  const publication = result.publication && 'generation' in result.publication ? result.publication : undefined
  return { generation: safeGeneration(publication?.generation), hash: safeHash(publication?.contentHash) }
}

/** Builds a text-only, non-delivering custom-bot body from the terminal run's safe fields. */
export function buildFeishuMessage(result: RunResult, previousFailure?: PreviousNotificationFailure): FeishuMessage {
  const publication = publicationSummary(result)
  const counts = COUNT_FIELDS.map((field) => `${field}=${count(result.counts[field])}`)
  const durations = DURATION_FIELDS
    .filter((field) => result.stageDurations[field] !== undefined)
    .map((field) => `${field}=${count(result.stageDurations[field])}ms`)
  const totalDuration = DURATION_FIELDS.reduce((total, field) => total + count(result.stageDurations[field]), 0)
  const lines = [
    `AiringCal sync ${safeText(result.status)}`,
    `run=${safeText(result.id)} mode=${safeText(result.mode)} source=${safeText(result.source)}`,
    `time=${localTime(result.finishedAt)}`,
    `generation=${publication.generation} hash=${publication.hash}`,
    ...counts,
    `duration=${totalDuration}ms`,
    ...durations,
    `publication=${safeText(result.components.publication, 'not_attempted')} backup=${safeText(result.components.backup, 'not_attempted')} notification=${safeText(result.components.notification, 'not_attempted')}`,
    'git_sha=unknown node=' + safeText(process.version) + ' alpine=unknown',
    ...(result.sanitizedError ? [`error=${errorSummary(result.sanitizedError, result.sanitizedError.attemptCount)}`] : []),
    ...(previousFailure ? [`previous_failure=${errorSummary(previousFailure)}`] : []),
  ]
  return { msg_type: 'text', content: { text: lines.join('\n') } }
}
