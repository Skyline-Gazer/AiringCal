import { subjectDetailImages } from '@airing-cal/domain'
import { nextSubjectRefreshAt, type MediaRefreshComponent } from '@airing-cal/storage'

export interface RefreshPlannerInput {
  subject_id: number
  title: string
  hot?: boolean
  images?: { common?: string; large?: string }
}

export interface CachedRefreshState {
  detail: { cached_at: number; subject: unknown } | null
  meta: { subject_id: number; exists: boolean | null; checked_at: number; reason: string } | null
  image: {
    common?: { status?: string; source_url?: string } | null
    large?: { status?: string; source_url?: string } | null
  } | null
  refresh: { subject_id: number; status: string; updated_at: number } | null
}

export interface RefreshCandidate extends RefreshPlannerInput {
  components: MediaRefreshComponent[]
  priority: RefreshPriority
}

export type RefreshPriority = 'new_or_changed' | 'hot' | 'cold' | 'retry'

export interface RefreshSelection {
  candidates: number
  selected: RefreshCandidate[]
  deferred: number
  deferred_candidates: RefreshCandidate[]
  by_priority: Record<RefreshPriority, number>
  cold_cursor: ColdRefreshCursor
}

export interface ColdRefreshCursor {
  subject_ids: number[]
}

const PRIORITY_ORDER: Record<RefreshPriority, number> = {
  new_or_changed: 0,
  hot: 1,
  cold: 2,
  retry: 3,
}

const COMPONENT_ORDER: Record<MediaRefreshComponent, number> = {
  detail: 0,
  meta: 1,
  image_common: 2,
  image_large: 3,
}

export function positiveMod(value: number, divisor: number): number {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(divisor) || divisor <= 0) {
    throw new Error('positiveMod requires safe integers and a positive integer divisor')
  }
  return ((value % divisor) + divisor) % divisor
}

function mergeCandidates(candidates: RefreshCandidate[]): RefreshCandidate[] {
  const merged = new Map<number, RefreshCandidate>()
  for (const candidate of candidates) {
    const current = merged.get(candidate.subject_id)
    if (!current) {
      merged.set(candidate.subject_id, {
        ...candidate,
        components: [...new Set(candidate.components)].sort((left, right) => COMPONENT_ORDER[left] - COMPONENT_ORDER[right]),
      })
      continue
    }
    const strongest = PRIORITY_ORDER[candidate.priority] < PRIORITY_ORDER[current.priority] ? candidate : current
    merged.set(candidate.subject_id, {
      ...strongest,
      components: [...new Set([...current.components, ...candidate.components])]
        .sort((left, right) => COMPONENT_ORDER[left] - COMPONENT_ORDER[right]),
    })
  }
  return [...merged.values()]
}

export function selectRefreshCandidates(
  candidates: RefreshCandidate[],
  utcDay: string,
  limits: { soft: number; hard: number },
  coldCursor: ColdRefreshCursor = { subject_ids: [] },
): RefreshSelection {
  const coldShard = new Date(`${utcDay}T00:00:00Z`).getUTCDay()
  if (!Number.isInteger(coldShard)) throw new Error('Invalid UTC day')
  const resumedColdOrder = new Map(coldCursor.subject_ids.map((subjectId, index) => [subjectId, index]))
  const eligible = mergeCandidates(candidates)
    .filter((candidate) =>
      candidate.priority !== 'cold'
      || resumedColdOrder.has(candidate.subject_id)
      || positiveMod(candidate.subject_id, 7) === coldShard)
    .sort((left, right) => {
      const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
      if (priority !== 0) return priority
      if (left.priority === 'cold' && right.priority === 'cold') {
        const leftResume = resumedColdOrder.get(left.subject_id)
        const rightResume = resumedColdOrder.get(right.subject_id)
        if (leftResume !== undefined || rightResume !== undefined) {
          if (leftResume === undefined) return 1
          if (rightResume === undefined) return -1
          return leftResume - rightResume
        }
      }
      return left.subject_id - right.subject_id
    })
  const byPriority: Record<RefreshPriority, number> = { new_or_changed: 0, hot: 0, cold: 0, retry: 0 }
  for (const candidate of eligible) byPriority[candidate.priority] += 1
  const limit = Math.min(limits.hard, Math.max(limits.soft, byPriority.new_or_changed))
  const selected = eligible.slice(0, limit)
  const deferredCandidates = eligible.slice(limit)
  return {
    candidates: eligible.length,
    selected,
    deferred: deferredCandidates.length,
    deferred_candidates: deferredCandidates,
    by_priority: byPriority,
    cold_cursor: {
      subject_ids: deferredCandidates
        .filter(({ priority }) => priority === 'cold')
        .map(({ subject_id }) => subject_id),
    },
  }
}

function imageNeedsRefresh(status: { status?: string; source_url?: string } | null | undefined, sourceUrl: string | undefined): boolean {
  if (!status) return true
  if (sourceUrl) return status.status !== 'cached' || status.source_url !== sourceUrl
  return status.status !== 'cached' && status.status !== 'missing_source'
}

function imageSourceChanged(
  status: { source_url?: string } | null | undefined,
  cachedSourceUrl: string | undefined,
  sourceUrl: string | undefined,
): boolean {
  const previousSourceUrl = status?.source_url ?? cachedSourceUrl
  return Boolean(sourceUrl && previousSourceUrl && previousSourceUrl !== sourceUrl)
}

export function planSubjectRefresh(input: RefreshPlannerInput, cached: CachedRefreshState, now: number): RefreshCandidate | null {
  if (!cached.detail) return { ...input, components: ['detail', 'meta'], priority: 'new_or_changed' }

  const cachedImages = subjectDetailImages(cached.detail.subject as Parameters<typeof subjectDetailImages>[0])
  const changedImages: MediaRefreshComponent[] = []
  if (imageSourceChanged(cached.image?.common, cachedImages.common, input.images?.common)) changedImages.push('image_common')
  if (imageSourceChanged(cached.image?.large, cachedImages.large, input.images?.large)) changedImages.push('image_large')
  if (changedImages.length) return { ...input, components: changedImages, priority: 'new_or_changed' }
  if (cached.refresh?.status === 'failed' || cached.refresh?.status === 'partial') {
    return { ...input, components: ['detail', 'meta', 'image_common', 'image_large'], priority: 'retry' }
  }

  const components: MediaRefreshComponent[] = []
  if (!cached.meta) components.push('meta')
  if (imageNeedsRefresh(cached.image?.common, input.images?.common)) components.push('image_common')
  if (imageNeedsRefresh(cached.image?.large, input.images?.large)) components.push('image_large')
  if (components.length) return { ...input, components, priority: 'new_or_changed' }
  if (nextSubjectRefreshAt(input.subject_id, cached.detail.cached_at) <= now) {
    return {
      ...input,
      components: ['detail', 'meta', 'image_common', 'image_large'],
      priority: input.hot === false ? 'cold' : 'hot',
    }
  }
  return null
}
