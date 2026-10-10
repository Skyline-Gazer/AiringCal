import {
  migrateKvBudgetDailyKey,
  migrateLegacyCursorKey,
  migrateLegacySummaryKey,
  migrateShadowStreakKey,
  PUBLIC_READ_MODE_KV_KEY,
  type KvBudgetDailyV1,
  type MigrationCursorV1,
  type MigrationSummaryV1,
  type ShadowStreakV1,
} from '@airing-cal/storage'
import { snapshotKey } from '@airing-cal/domain'
import type { SnapshotSource } from './r2-snapshot.ts'

const MEDIA_SOFT_LIMIT = 50
const MEDIA_HARD_LIMIT = 100
const KV_BUDGET_MAX_WRITES = 100
const KV_BUDGET_WINDOW_DAYS = 7

export interface MigrationHealthKv {
  get(key: string, type: 'json'): Promise<unknown>
}

export interface MigrationHealthD1 {
  getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined>
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>
    }
  }
}

export interface MigrationHealthEnv {
  AIRING_CAL_KV: MigrationHealthKv
  AIRING_CAL_D1: MigrationHealthD1
}

export interface MigrationHealth {
  snapshot: {
    source: 'legacy' | 'r2' | 'cache'
    generation: number | null
    r2_key: string | null
    verified_at: number | null
  }
  migration: {
    shadow_streak: number
    cursor: number | null
    imported: number
    skipped_existing: number
    missing_keys: number
    kv_budget_ok: boolean
    read_mode: 'legacy' | 'r2'
  }
  budget: {
    media: { reserved: number; consumed: number; soft_limit: number; hard_limit: number }
  }
  degraded: boolean
}

function dateAtOffset(date: string, offsetDays: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day))
  value.setUTCDate(value.getUTCDate() + offsetDays)
  return value.toISOString().slice(0, 10)
}

function decodeShadowStreak(value: unknown): ShadowStreakV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.streak) || (candidate.streak as number) < 0
    || typeof candidate.updated_at !== 'number') return undefined
  return {
    streak: candidate.streak as number,
    last_success_at: typeof candidate.last_success_at === 'number' ? candidate.last_success_at as number : null,
    last_diff_summary: typeof candidate.last_diff_summary === 'string' ? candidate.last_diff_summary as string : null,
    updated_at: candidate.updated_at as number,
  }
}

function decodeMigrationSummary(value: unknown): MigrationSummaryV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  for (const key of ['imported', 'skipped_existing', 'missing_keys', 'errored'] as const) {
    if (!Number.isSafeInteger(candidate[key]) || (candidate[key] as number) < 0) return undefined
  }
  if (typeof candidate.updated_at !== 'number') return undefined
  return {
    imported: candidate.imported as number,
    skipped_existing: candidate.skipped_existing as number,
    missing_keys: candidate.missing_keys as number,
    errored: candidate.errored as number,
    updated_at: candidate.updated_at as number,
  }
}

function decodeMigrationCursor(value: unknown): MigrationCursorV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.last_subject_id) || (candidate.last_subject_id as number) < 0
    || typeof candidate.updated_at !== 'number') return undefined
  return {
    last_subject_id: candidate.last_subject_id as number,
    batch_index: Number.isSafeInteger(candidate.batch_index) ? candidate.batch_index as number : 0,
    updated_at: candidate.updated_at as number,
  }
}

function decodeKvBudgetDaily(value: unknown): KvBudgetDailyV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.date !== 'string'
    || !Number.isSafeInteger(candidate.legacy_subject_kv_writes)
    || (candidate.legacy_subject_kv_writes as number) < 0) return undefined
  return {
    date: candidate.date as string,
    legacy_subject_kv_writes: candidate.legacy_subject_kv_writes as number,
    updated_at: typeof candidate.updated_at === 'number' ? candidate.updated_at as number : 0,
  }
}

async function kvBudgetOk(d1: MigrationHealthD1): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)
  for (let offset = 0; offset < KV_BUDGET_WINDOW_DAYS; offset++) {
    const budget = await d1.getAppState(
      migrateKvBudgetDailyKey(dateAtOffset(today, -offset)),
      decodeKvBudgetDaily,
    )
    if (!budget || budget.legacy_subject_kv_writes > KV_BUDGET_MAX_WRITES) return false
  }
  return true
}

async function readMediaBudget(
  d1: MigrationHealthD1,
): Promise<{ reserved: number; consumed: number } | null> {
  const date = new Date().toISOString().slice(0, 10)
  const row = await d1.prepare(
    'SELECT reserved, consumed FROM sync_budget WHERE date = ? AND resource = ?',
  ).bind(date, 'media').first<{ reserved: number; consumed: number }>()
  if (!row || !Number.isSafeInteger(row.reserved) || !Number.isSafeInteger(row.consumed)) return null
  return { reserved: row.reserved, consumed: row.consumed }
}

export async function buildMigrationHealth(env: MigrationHealthEnv, source?: SnapshotSource): Promise<MigrationHealth> {
  let degraded = false
  let readModeValue: unknown
  try {
    readModeValue = await env.AIRING_CAL_KV.get(PUBLIC_READ_MODE_KV_KEY, 'json')
  } catch {
    degraded = true
  }
  const readMode = typeof readModeValue === 'object'
    && readModeValue !== null
    && !Array.isArray(readModeValue)
    && (readModeValue as { mode?: unknown }).mode === 'r2'
    ? 'r2'
    : 'legacy'
  const snapshot = source && source.mode !== 'legacy'
    ? {
        source: source.mode,
        generation: source.snapshot.generation,
        r2_key: snapshotKey(source.snapshot.generation, source.snapshot.content_hash),
        verified_at: source.snapshot.published_at,
      }
    : {
        source: 'legacy' as const,
        generation: null,
        r2_key: null,
        verified_at: null,
      }

  let migration: MigrationHealth['migration'] = {
    shadow_streak: 0,
    cursor: null,
    imported: 0,
    skipped_existing: 0,
    missing_keys: 0,
    kv_budget_ok: false,
    read_mode: readMode,
  }
  let budget: MigrationHealth['budget'] = {
    media: { reserved: 0, consumed: 0, soft_limit: MEDIA_SOFT_LIMIT, hard_limit: MEDIA_HARD_LIMIT },
  }
  try {
    const streak = await env.AIRING_CAL_D1.getAppState(migrateShadowStreakKey(), decodeShadowStreak)
    const summary = await env.AIRING_CAL_D1.getAppState(migrateLegacySummaryKey(), decodeMigrationSummary)
    const cursor = await env.AIRING_CAL_D1.getAppState(migrateLegacyCursorKey(), decodeMigrationCursor)
    migration = {
      ...migration,
      shadow_streak: streak?.streak ?? 0,
      cursor: cursor?.last_subject_id ?? null,
      imported: summary?.imported ?? 0,
      skipped_existing: summary?.skipped_existing ?? 0,
      missing_keys: summary?.missing_keys ?? 0,
      kv_budget_ok: await kvBudgetOk(env.AIRING_CAL_D1),
    }
    const media = await readMediaBudget(env.AIRING_CAL_D1)
    if (media) {
      budget = {
        media: {
          ...media,
          soft_limit: MEDIA_SOFT_LIMIT,
          hard_limit: MEDIA_HARD_LIMIT,
        },
      }
    }
  } catch {
    degraded = true
  }
  return { snapshot, migration, budget, degraded }
}
