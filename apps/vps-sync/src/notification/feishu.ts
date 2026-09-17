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

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function safeText(value: unknown, fallback = 'unknown'): string {
  const text = redactText(typeof value === 'string' ? value : String(value))
  return text || fallback
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
    ...(result.sanitizedError ? [`error=${redactText(`${safeText(result.sanitizedError.category)}/${safeText(result.sanitizedError.code)}/${safeText(result.sanitizedError.stage)}/attempt=${count(result.sanitizedError.attemptCount)}`)}`] : []),
    ...(previousFailure ? [`previous_failure=${redactText(`${safeText(previousFailure.category)}/${safeText(previousFailure.code)}/${safeText(previousFailure.stage)}`)}`] : []),
  ]
  return { msg_type: 'text', content: { text: lines.join('\n') } }
}
