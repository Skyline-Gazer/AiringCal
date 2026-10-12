import type { RunContext } from '../adapters/run-context.ts'

export interface MediaRefreshSummary {
  selected: number
  succeeded: number
  failed: number
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
    return { selected: 0, succeeded: 0, failed: 0 }
  },
}
