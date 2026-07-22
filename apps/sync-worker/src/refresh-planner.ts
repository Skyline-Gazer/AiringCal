import { nextSubjectRefreshAt, type MediaRefreshComponent } from '@airing-cal/storage'

export interface RefreshPlannerInput {
  subject_id: number
  title: string
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
}

function imageNeedsRefresh(status: { status?: string; source_url?: string } | null | undefined, sourceUrl: string | undefined): boolean {
  if (!status) return true
  if (sourceUrl) return status.status !== 'cached' || status.source_url !== sourceUrl
  return status.status !== 'cached' && status.status !== 'missing_source'
}

export function planSubjectRefresh(input: RefreshPlannerInput, cached: CachedRefreshState, now: number): RefreshCandidate | null {
  if (!cached.detail) return { ...input, components: ['detail', 'meta'] }
  if (nextSubjectRefreshAt(input.subject_id, cached.detail.cached_at) <= now) {
    return { ...input, components: ['detail', 'meta', 'image_common', 'image_large'] }
  }

  const components: MediaRefreshComponent[] = []
  if (!cached.meta) components.push('meta')
  if (imageNeedsRefresh(cached.image?.common, input.images?.common)) components.push('image_common')
  if (imageNeedsRefresh(cached.image?.large, input.images?.large)) components.push('image_large')
  return components.length ? { ...input, components } : null
}
