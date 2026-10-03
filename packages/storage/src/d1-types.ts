export interface PublicImageRefV1 {
  hash: string
  uri: string
  r2_key: string
}

export interface PublicSubjectImagesV1 {
  common: PublicImageRefV1 | null
  large: PublicImageRefV1 | null
}

export interface PublicImageStatusV1 {
  common: string
  large: string
}

export interface PublicSubjectRatingV1 {
  score: number
  rank: number
  total: number
}

export interface PublicCollectionItemV1 {
  subject_id: number
  name: string
  name_cn: string
  summary: string
  images: PublicSubjectImagesV1
  image_status: PublicImageStatusV1
  rating?: PublicSubjectRatingV1
  eps: number
  total_episodes: number
  ep_status: number
  vol_status: number
  type: number
  collection_type: number
  rate: number
  nsfw: boolean
  date: string
  tags: string[]
  updated_at: string
}

export interface PublicCalendarSubjectV1 {
  subject_id: number
  id: number
  type: number
  name: string
  name_cn: string
  summary: string
  images: PublicSubjectImagesV1
  image_status: PublicImageStatusV1
  nsfw: boolean
  date: string
  eps: number
  total_episodes: number
  rating?: PublicSubjectRatingV1
}

export interface PublicCalendarDayV1 {
  weekday: {
    en: string
    cn: string
    ja: string
    id: number
  }
  items: PublicCalendarSubjectV1[]
}

export interface PublicSnapshotSummaryV1 {
  want: number
  watched: number
  watching: number
  on_hold: number
  dropped: number
  _total: number
}

export interface PublicSnapshotV1 {
  schema_version: 1
  generation: number
  content_hash: string
  published_at: number
  collections: Record<'want' | 'watched' | 'watching' | 'on_hold' | 'dropped', PublicCollectionItemV1[]>
  calendar: PublicCalendarDayV1[]
  summary: PublicSnapshotSummaryV1
}

export interface D1MetaLike {
  duration: number
  size_after: number
  rows_read: number
  rows_written: number
  last_row_id: number
  changed_db: boolean
  changes: number
  served_by_region?: string
  served_by_colo?: string
  served_by_primary?: boolean
  timings?: { sql_duration_ms: number }
  total_attempts?: number
  [key: string]: unknown
}

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[]
  success: true
  meta: D1MetaLike
  error?: never
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>
  raw<T = unknown[]>(): Promise<T[]>
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike
  batch<T = Record<string, unknown>>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>
  exec(query: string): Promise<{ count: number; duration: number }>
}
