import type { CompleteStateInput, RunStartInput, RunFinishInput } from './postgres/repositories.ts'

export type RunRequest = Pick<RunStartInput, 'mode' | 'source'>
export type RunStatus = RunFinishInput['status']
export type PublicationResult =
  | { status: 'published' | 'no_change'; generation: number; contentHash: string }
  | { status: 'failed' | 'skipped' }
export type MediaSummary = { selected: number; succeeded: number; failed: number }
export type RunResult = RunFinishInput & { source: RunRequest['source']; mode: RunRequest['mode']; publication?: PublicationResult }
export type RunContext = RunRequest & { runId: string; observedAt: string }

export interface RunDependencies {
  runId: string
  gitSha: string
  now(): number
  lock: { acquire(): Promise<boolean>; release(): Promise<void> }
  authority: {
    beginRun(input: RunStartInput): Promise<void>
    heartbeat(id: string, stage: string, at: string): Promise<void>
    commitCompleteState(input: CompleteStateInput): Promise<RunFinishInput['counts'] | void>
    finishRun(input: RunFinishInput): Promise<void>
  }
  /** Returns only a validated, complete collection/calendar projection. */
  fetchComplete(context: RunContext): Promise<CompleteStateInput>
  media(context: RunContext): Promise<MediaSummary>
  publish(context: RunContext): Promise<PublicationResult>
  backup(context: RunContext, publication: Extract<PublicationResult, { generation: number }>): Promise<void>
  notify(result: RunResult): Promise<void>
  close(): Promise<void>
}
