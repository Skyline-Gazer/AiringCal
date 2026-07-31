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
  /** Optimistic-concurrency revision only; excluded from business hashes and public snapshots. */
  state_version: number
  temperature: Temperature
  first_seen_at: number
  changed_at: number
  missing_since: number | null
  deleted_at: number | null
}

export interface CollectionDiffPlanLike {
  inserts: CollectionRow[]
  updates: CollectionRow[]
  unchanged: number
  firstMissing: CollectionRow[]
  confirmedDeleted: CollectionRow[]
  restored: CollectionRow[]
}

export interface SyncRunUpdate {
  stage: string
  heartbeat_at: number
  generation?: number | null
  collection_count?: number
  changed_count?: number
  missing_count?: number
  deleted_count?: number
  media_selected_count?: number
  media_granted_count?: number
  input_hash?: string | null
  public_hash?: string | null
  result_json?: string | null
}

export interface SyncRunCheckpointGuard {
  stage: string
  result_json: string | null
}

export interface SyncRunCompletion {
  heartbeat_at: number
  completed_at: number
  generation?: number | null
  input_hash?: string | null
  public_hash?: string | null
  result_json?: string | null
}

export interface SyncRunFailure {
  heartbeat_at: number
  completed_at: number
  error_code: string
}

export interface SyncTerminalTransitionResult {
  outcome: 'applied' | 'already_same_terminal' | 'preserved_opposite_terminal'
  terminal: 'ok' | 'error'
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
  result_json: string | null
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

export interface PublicSnapshotPointerV1 {
  schema_version: 1
  generation: number
  content_hash: string
  r2_key: string
  published_at: number
}

export interface PublicationWriteOwner {
  publication_id: string
  attempt_token: string
}

export interface PublicationSourceWatermarkV1 {
  schema_version: 1
  source_observed_at: number
  publication_id: string
  content_hash: string
}

export type PublicationPendingCleanupResult =
  | 'clean'
  | 'cleaned'
  | 'active'
  | 'stale'
  | 'conflict'

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
