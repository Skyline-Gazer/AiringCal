import type { CompleteStateInput, RunStartInput, RunFinishInput } from './postgres/repositories.ts'
import type { TracingPort } from './observability/tracing.ts'
import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import type { ProjectionUser } from './upstream/projection.ts'
import type { PreviousNotificationFailure } from './notification/feishu.ts'

export type RunRequest = Pick<RunStartInput, 'mode' | 'source'>
export type RunStatus = RunFinishInput['status']
export type PublicationResult =
  | { status: 'published' | 'no_change'; generation: number; contentHash: string }
  | { status: 'failed' | 'skipped' }
export type MediaSummary = { selected: number; succeeded: number; failed: number }
export type RunResult = RunFinishInput & { source: RunRequest['source']; mode: RunRequest['mode']; gitSha?: string; publication?: PublicationResult }
export type RunContext = RunRequest & { runId: string; observedAt: string }

export interface RunDependencies {
  runId: string
  gitSha: string
  projectionUsers: readonly ProjectionUser[]
  now(): number
  lock: { acquire(): Promise<boolean>; release(): Promise<void> }
  authority: {
    beginRun(input: RunStartInput): Promise<void>
    heartbeat(id: string, stage: string, at: string): Promise<void>
    commitCompleteState(input: CompleteStateInput): Promise<RunFinishInput['counts'] | void>
    finishRun(input: RunFinishInput): Promise<void>
    previousNotificationFailure?(): Promise<PreviousNotificationFailure | undefined>
  }
  /** Returns only a validated, complete upstream collection/calendar observation. */
  fetchComplete(context: RunContext): Promise<CompleteFullFetch>
  media(context: RunContext): Promise<MediaSummary>
  publish(context: RunContext): Promise<PublicationResult>
  backup(context: RunContext, publication: Extract<PublicationResult, { generation: number }>): Promise<void>
  notify(result: RunResult, previousFailure?: PreviousNotificationFailure): Promise<'sent' | 'failed'>
  close(): Promise<void>
  /** Optional observability boundary; omitted tracing remains a no-op. */
  tracing?: TracingPort
}
