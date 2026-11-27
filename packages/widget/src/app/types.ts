export type CollectionType = 'want' | 'watched' | 'watching' | 'on_hold' | 'dropped'

export const COLLECTION_TYPES: { key: CollectionType; label: string }[] = [
  { key: 'want', label: '想看' },
  { key: 'watched', label: '看过' },
  { key: 'watching', label: '在看' },
  { key: 'on_hold', label: '搁置' },
  { key: 'dropped', label: '抛弃' },
]

export interface ImageRef {
  hash: string
  uri: string
}

export interface SubjectImages {
  common: ImageRef | null
  large: ImageRef | null
}

export interface CollectionItem {
  subject_id: number
  name: string
  name_cn: string
  images: SubjectImages
  image_status: { common: string; large: string }
  eps: number
  total_episodes: number
  ep_status: number
  nsfw: boolean
  rating?: { score: number }
}

export interface CollectionsResponse {
  data: CollectionItem[]
  total: number
  page: number
  limit: number
}

export interface CalendarItem {
  id: number
  subject_id: number
  name: string
  name_cn: string
  images: SubjectImages
  image_status: { common: string; large: string }
  nsfw: boolean
  eps: number
  total_episodes: number
  rating?: { score: number }
}

export interface CalendarDay {
  weekday: { id: number; cn: string; en: string; ja: string }
  items: CalendarItem[]
}

export interface HealthResponse {
  ok: boolean
  data?: {
    collections: { updated_at: string }
    cache: { total_subjects: number }
  }
}

export interface BuildInfo {
  commitSha?: string
  builtAt?: string
}

declare global {
  interface Window {
    bgmConfig?: { apiUrl?: string; quote?: string }
    __AIRINGCAL_BUILD__?: BuildInfo
  }
}
