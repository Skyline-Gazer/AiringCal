export type Temperature = 'hot' | 'cold'
export type SyncBudgetResource = 'media'
export type BudgetSubmissionStatus = 'reserved' | 'submitted' | 'uncertain'

export interface CollectionRow {
  user_id: string
  subject_id: number
  collection_type: number
  rate: number | null
  tags_json: string
  comment: string
  ep_status: number
  vol_status: number
  upstream_updated_at: string | null
  subject_json: string
  content_hash: string
  temperature: Temperature
  first_seen_at: number
  changed_at: number
  missing_since: number | null
  deleted_at: number | null
}

export interface SubjectMediaRow {
  subject_id: number
  detail_json: string | null
  detail_hash: string | null
  media_hash: string | null
  nsfw: 0 | 1
  source_image_common_url: string | null
  source_image_large_url: string | null
  r2_image_common_key: string | null
  r2_image_large_key: string | null
  checked_at: number | null
  next_refresh_at: number | null
  retry_count: number
  retry_after: number | null
  error_code: string | null
}

export interface SyncRunRow {
  instance_id: string
  status: string
  stage: string
  generation: number | null
  collection_count: number
  changed_count: number
  missing_count: number
  deleted_count: number
  media_selected_count: number
  media_granted_count: number
  input_hash: string | null
  public_hash: string | null
  error_code: string | null
  started_at: number
  heartbeat_at: number
  completed_at: number | null
}

export interface SyncBudgetRow {
  date: string
  resource: SyncBudgetResource
  reserved: number
  consumed: number
  updated_at: number
}

export interface SyncBudgetReservationRow {
  reservation_id: string
  date: string
  resource: SyncBudgetResource
  request_fingerprint: string
  result_json: string
  submission_status: BudgetSubmissionStatus
  created_at: number
  updated_at: number
}

export interface AppStateRow {
  key: string
  value_json: string
  updated_at: number
}

export interface PublicSnapshotV1 {
  schema_version: 1
  generation: number
  content_hash: string
  collections: Record<'want' | 'watched' | 'watching' | 'on_hold' | 'dropped', unknown[]>
  calendar: unknown
  summary: unknown
}

export interface PublicSnapshotPointerV1 {
  schema_version: 1
  generation: number
  content_hash: string
  r2_key: string
  published_at: number
}

export interface D1ResultLike<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta?: Record<string, unknown>
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
