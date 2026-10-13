import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import type { RunContext } from '../adapters/run-context.ts'
import type { MediaSubjectSource } from './media-port.ts'
import { bangumiImageUrl, mediaSubjectsFromFetch } from './media-refresh.ts'
import { emitProgress, emitStage } from './sync-progress.ts'

const DEFAULT_MAX_DETAIL_FETCHES = 120
const DEFAULT_CONCURRENCY = 4
const PROGRESS_EVERY = 5
const PROGRESS_MIN_MS = 2_000

export interface SubjectDetailFetchResult {
  common?: string
  large?: string
}

export interface EnrichMediaSubjectsOptions {
  fetchSubjectDetail(subjectId: number): Promise<SubjectDetailFetchResult | null>
  guard?: () => void
  signal?: AbortSignal
  maxDetailFetches?: number
  concurrency?: number
}

function hasResolvableImage(subject: MediaSubjectSource): boolean {
  return Boolean(bangumiImageUrl(subject.images.common) || bangumiImageUrl(subject.images.large))
}

function mergeDetailImages(target: MediaSubjectSource, detail: SubjectDetailFetchResult): void {
  if (typeof detail.common === 'string' && detail.common && !target.images.common) {
    target.images.common = detail.common
  }
  if (typeof detail.large === 'string' && detail.large && !target.images.large) {
    target.images.large = detail.large
  }
}

async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export async function enrichMediaSubjectsFromFetch(
  input: CompleteFullFetch,
  options: EnrichMediaSubjectsOptions,
): Promise<MediaSubjectSource[]> {
  const subjects = mediaSubjectsFromFetch(input)
  const missing = subjects.filter((subject) => !hasResolvableImage(subject))
  if (missing.length === 0) {
    emitStage('Subject detail enrich skipped (all sources present)', {
      stage: 'subject_detail_enrich',
      missing: 0,
      subject_total: subjects.length,
    })
    return subjects
  }

  const maxDetailFetches = options.maxDetailFetches ?? DEFAULT_MAX_DETAIL_FETCHES
  const toFetch = missing.slice(0, maxDetailFetches)
  const byId = new Map(subjects.map((subject) => [subject.subjectId, subject]))
  const total = toFetch.length

  emitStage('Subject detail enrich started', {
    stage: 'subject_detail_enrich',
    missing: missing.length,
    fetching: total,
    capped: missing.length > toFetch.length,
    cap: maxDetailFetches,
  })

  let fetched = 0
  let notFound = 0
  let failed = 0
  let processed = 0
  let lastProgressAt = 0
  const maybeProgress = () => {
    if (total <= 0) return
    const now = Date.now()
    if (processed >= total || processed % PROGRESS_EVERY === 0 || now - lastProgressAt >= PROGRESS_MIN_MS) {
      emitProgress('detail', 'subject_detail_progress', processed, total, { fetched, not_found: notFound, failed })
      lastProgressAt = now
    }
  }

  await mapPool(toFetch, options.concurrency ?? DEFAULT_CONCURRENCY, async (stub) => {
    try {
      if (options.signal?.aborted) return
      options.guard?.()
      const target = byId.get(stub.subjectId)
      if (!target || hasResolvableImage(target)) return
      try {
        const detail = await options.fetchSubjectDetail(stub.subjectId)
        if (!detail) {
          notFound += 1
        } else {
          mergeDetailImages(target, detail)
          if (hasResolvableImage(target)) fetched += 1
        }
      } catch {
        failed += 1
      }
    } finally {
      processed += 1
      maybeProgress()
    }
  })

  if (total > 0 && processed > 0) {
    emitProgress('detail', 'subject_detail_progress', processed, total, { fetched, not_found: notFound, failed })
  }

  console.log(JSON.stringify({
    status: 'info',
    stage: 'subject_detail_enrich',
    missing: missing.length,
    fetched,
    not_found: notFound,
    failed,
    capped: missing.length > toFetch.length,
    cap: maxDetailFetches,
  }))

  return subjects
}

export function createEnrichMediaSubjectsFromFetch(
  fetchSubjectDetail: EnrichMediaSubjectsOptions['fetchSubjectDetail'],
  overrides: Omit<EnrichMediaSubjectsOptions, 'fetchSubjectDetail'> = {},
): (input: CompleteFullFetch, run: RunContext) => Promise<MediaSubjectSource[]> {
  return (input, run) => enrichMediaSubjectsFromFetch(input, {
    fetchSubjectDetail,
    guard: () => run.guard(),
    signal: run.signal,
    ...overrides,
  })
}
