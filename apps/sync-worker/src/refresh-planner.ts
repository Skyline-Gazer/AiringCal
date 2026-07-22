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
  by_priority: Record<RefreshPriority, number>
}

const PRIORITY_ORDER: Record<RefreshPriority, number> = {
  new_or_changed: 0,
  hot: 1,
  cold: 2,
  retry: 3,
}

export function selectRefreshCandidates(
  candidates: RefreshCandidate[],
  utcDay: string,
  limits: { soft: number; hard: number },
): RefreshSelection {
  const coldShard = new Date(`${utcDay}T00:00:00Z`).getUTCDay()
  const eligible = candidates
    .filter((candidate) => candidate.priority !== 'cold' || Math.abs(Math.trunc(candidate.subject_id)) % 7 === coldShard)
    .sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] || left.subject_id - right.subject_id)
  const byPriority: Record<RefreshPriority, number> = { new_or_changed: 0, hot: 0, cold: 0, retry: 0 }
  for (const candidate of eligible) byPriority[candidate.priority] += 1
  const limit = Math.min(limits.hard, Math.max(limits.soft, byPriority.new_or_changed))
  const selected = eligible.slice(0, limit)
  return {
    candidates: eligible.length,
    selected,
    deferred: eligible.length - selected.length,
    by_priority: byPriority,
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
