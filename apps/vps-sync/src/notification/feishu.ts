import { createHmac } from 'node:crypto'
import type { RunResult } from '../contracts.ts'
import { redactText } from './redact.ts'

export type FeishuMessage = Readonly<{ msg_type: 'text'; content: Readonly<{ text: string }> }>
export type PreviousNotificationFailure = Readonly<{ category: string; code: string; stage: string }>

/** Feishu custom bot signs an empty body with HMAC-SHA256(timestamp + newline + secret). */
export function signFeishu(timestamp: string, secret: string): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

function count(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0 }

function gitSha(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : 'unknown' }

function localTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'invalid' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false,
  }).format(date)
}

/** Builds a text-only, non-delivering custom-bot body from the terminal run's safe fields. */
export function buildFeishuMessage(result: RunResult, previousFailure?: PreviousNotificationFailure): FeishuMessage {
  const publication = result.publication && 'generation' in result.publication ? result.publication : undefined
  const lines = [
    `AiringCal sync ${result.status}`,
    `run=${result.id} mode=${result.mode} source=${result.source}`,
    `time=${localTime(result.finishedAt)}`,
    `generation=${publication?.generation ?? 'none'} hash=${publication?.contentHash ?? 'none'}`,
    `users=${count(result.counts.users)} collections=${count(result.counts.collections)} inserted=${count(result.counts.inserted)} updated=${count(result.counts.updated)}`,
    ...Object.entries(result.stageDurations).map(([stage, duration]) => `${stage}=${count(duration)}ms`),
    `publication=${result.components.publication ?? 'not_attempted'} backup=${result.components.backup ?? 'not_attempted'} notification=${result.components.notification ?? 'not_attempted'}`,
    `git_sha=${gitSha(result.gitSha)} node=${process.version} alpine=unknown`,
    ...(result.sanitizedError ? [`error=${redactText(`${result.sanitizedError.category}/${result.sanitizedError.code}/${result.sanitizedError.stage}`)}`] : []),
    ...(previousFailure ? [`previous_failure=${redactText(`${previousFailure.category}/${previousFailure.code}/${previousFailure.stage}`)}`] : []),
  ]
  return { msg_type: 'text', content: { text: lines.join('\n') } }
}
