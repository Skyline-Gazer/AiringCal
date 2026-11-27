import type {
  CalendarDay,
  CollectionItem,
  CollectionType,
  CollectionsResponse,
  HealthResponse,
} from './types.ts'

export function apiBase(): string {
  const configured = window.bgmConfig?.apiUrl?.trim()
  return (configured || window.location.origin).replace(/\/$/, '')
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiBase() + path, signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  return await response.json() as T
}

export function fetchCollections(
  params: { type: CollectionType; page: number; limit: number; nsfw: 'hide' | 'show' },
  signal?: AbortSignal,
): Promise<CollectionsResponse> {
  const query = new URLSearchParams({
    type: params.type,
    page: String(params.page),
    limit: String(params.limit),
    nsfw: params.nsfw,
  })
  return getJson<CollectionsResponse>(`/api/collections?${query}`, signal)
}

export async function fetchCalendar(signal?: AbortSignal): Promise<CalendarDay[]> {
  return await getJson<CalendarDay[]>('/api/calendar', signal)
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return await getJson<HealthResponse>('/api/health', signal)
}

export async function fetchNsfwEnabled(signal?: AbortSignal): Promise<boolean> {
  const body = await getJson<{ nsfw?: boolean }>('/api/config?key=nsfw', signal)
  return body.nsfw === true
}

export function visibleItems<T extends { nsfw: boolean }>(items: T[], showNsfw: boolean): T[] {
  return showNsfw ? items : items.filter((item) => !item.nsfw)
}

export function subjectThumbUrl(images: CollectionItem['images']): string | null {
  const hash = images.large?.hash ?? images.common?.hash
  return hash ? `${apiBase()}/image/${hash}/thumb` : null
}

export function subjectFallbackUrl(images: CollectionItem['images']): string | null {
  const uri = images.large?.uri ?? images.common?.uri
  return uri ? `${apiBase()}${uri}` : null
}
