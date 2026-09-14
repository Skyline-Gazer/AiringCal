import type {
  CompleteState,
  CompleteStateInput,
  RunFinish,
  RunFinishInput,
  RunStart,
  RunStartInput,
} from './postgres/repositories.js'

export type RunRequest = { mode: 'shadow' | 'live'; source: 'scheduled' | 'manual' }
export type RunStatus = RunFinishInput['status']
export type PublicationResult =
  | { status: 'published' | 'no_change'; generation: number; contentHash: string }
  | { status: 'failed' | 'skipped' }
export type MediaSummary = { selected: number; succeeded: number; failed: number }
export type RunResult = RunFinishInput & {
  source: RunRequest['source']
  mode: RunRequest['mode']
  publication?: PublicationResult
}
export type RunContext = RunRequest & { runId: string; observedAt: string }

export interface RunDependencies {
  runId: string
  gitSha: string
  now(): number
  lock: { acquire(): Promise<boolean>; release(): Promise<void> }
  authority: {
    beginRun(input: RunStart | RunStartInput): Promise<void>
    heartbeat(id: string, stage: string, at: string): Promise<void>
    commitCompleteState(input: CompleteState | CompleteStateInput): Promise<RunFinishInput['counts'] | void>
    finishRun(input: RunFinish | RunFinishInput | RunResult): Promise<void>
  }
  /** Returns only a validated, complete collection/calendar projection. */
  fetchComplete(context: RunContext): Promise<CompleteState | CompleteStateInput>
  media(context: RunContext): Promise<MediaSummary>
  publish(context: RunContext): Promise<PublicationResult>
  backup(context: RunContext, publication: Extract<PublicationResult, { generation: number }>): Promise<void>
  notify(result: RunResult): Promise<void>
  close(): Promise<void>
}
