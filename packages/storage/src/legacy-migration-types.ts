export const MIGRATE_LEGACY_CURSOR_KEY = 'migrate:legacy:cursor'
export const MIGRATE_LEGACY_SUMMARY_KEY = 'migrate:legacy:summary'
export const MIGRATE_SHADOW_STREAK_KEY = 'migrate:shadow:streak'
export const MIGRATE_READ_MODE_KEY = 'migrate:read-mode'
export const MIGRATE_KV_BUDGET_DAILY_KEY = 'migrate:kv-budget-daily'
export const MIGRATE_CLEANUP_CURSOR_KEY = 'migrate:cleanup:cursor'
export const PUBLIC_READ_MODE_KV_KEY = 'public:read-mode'

export interface MigrationCursorV1 {
  last_subject_id: number
  batch_index: number
  updated_at: number
}

export interface MigrationSummaryV1 {
  imported: number
  skipped_existing: number
  missing_keys: number
  errored: number
  updated_at: number
}

export interface ShadowStreakV1 {
  streak: number
  last_success_at: number | null
  last_diff_summary: string | null
  updated_at: number
}

export interface ReadModeV1 {
  mode: 'legacy' | 'r2'
  switched_at: number | null
}

export interface KvBudgetDailyV1 {
  date: string
  legacy_subject_kv_writes: number
  updated_at: number
}

export interface CleanupCursorV1 {
  last_subject_id: number | null
  deleted_count: number
  updated_at: number
}

export function migrateLegacyCursorKey(): string {
  return MIGRATE_LEGACY_CURSOR_KEY
}

export function migrateLegacySummaryKey(): string {
  return MIGRATE_LEGACY_SUMMARY_KEY
}

export function migrateShadowStreakKey(): string {
  return MIGRATE_SHADOW_STREAK_KEY
}

export function migrateReadModeKey(): string {
  return MIGRATE_READ_MODE_KEY
}

export function migrateKvBudgetDailyKey(date?: string): string {
  return date === undefined ? MIGRATE_KV_BUDGET_DAILY_KEY : `${MIGRATE_KV_BUDGET_DAILY_KEY}:${date}`
}

export function migrateCleanupCursorKey(): string {
  return MIGRATE_CLEANUP_CURSOR_KEY
}

export function publicReadModeKvKey(): string {
  return PUBLIC_READ_MODE_KV_KEY
}
