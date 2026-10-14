import type { RunContext } from '../adapters/run-context.ts'

export interface MediaRefreshFailure {
  subject_id: number
  error_code: string
  sizes: Array<'common' | 'large'>
}

export interface MediaRefreshSummary {
  selected: number
  succeeded: number
  failed: number
  /** Failed subjects from this run (for logs / ops). */
  failures: MediaRefreshFailure[]
  /** Large image content hashes persisted this run (for thumb-gen batch). */
  large_hashes_persisted: string[]
}

export interface MediaSubjectSource {
  subjectId: number
  nsfw: boolean
  images: { common?: string; large?: string }
}

export interface MediaRefreshRequest {
  subjects: MediaSubjectSource[]
}

export interface MediaRefreshPort {
  refresh(context: RunContext & { observedAt: string }, request?: MediaRefreshRequest): Promise<MediaRefreshSummary>
}

export const noopMediaRefresh: MediaRefreshPort = {
  async refresh() {
    return { selected: 0, succeeded: 0, failed: 0, failures: [], large_hashes_persisted: [] }
  },
}
