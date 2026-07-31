import {
  canonicalJson,
  migrateKvBudgetDailyKey,
  migrateReadModeKey,
  migrateShadowStreakKey,
  PUBLIC_READ_MODE_KV_KEY,
  type KvBudgetDailyV1,
  type ReadModeV1,
  type ShadowStreakV1,
} from '@airing-cal/storage'

export const REQUIRED_SHADOW_STREAK = 7
export const MAX_LEGACY_KV_WRITES_PER_DAY = 100

export interface ShadowGateD1 {
  getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined>
  putAppStateIfNewer<T>(key: string, value: T, version: number): Promise<boolean>
}

export interface ReadModeKv {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string): Promise<void>
}

export function decodeShadowStreak(value: unknown): ShadowStreakV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid shadow streak')
  }
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.streak) || (candidate.streak as number) < 0
    || !(candidate.last_success_at === null || typeof candidate.last_success_at === 'number')
    || !(candidate.last_diff_summary === null || typeof candidate.last_diff_summary === 'string')
    || typeof candidate.updated_at !== 'number') {
    throw new Error('Invalid shadow streak')
  }
  return {
    streak: candidate.streak as number,
    last_success_at: candidate.last_success_at as number | null,
    last_diff_summary: candidate.last_diff_summary as string | null,
    updated_at: candidate.updated_at as number,
  }
}

export function decodeKvBudgetDaily(value: unknown): KvBudgetDailyV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid daily KV budget')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.date !== 'string'
    || !Number.isSafeInteger(candidate.legacy_subject_kv_writes)
    || (candidate.legacy_subject_kv_writes as number) < 0
    || typeof candidate.updated_at !== 'number') {
    throw new Error('Invalid daily KV budget')
  }
  return {
    date: candidate.date as string,
    legacy_subject_kv_writes: candidate.legacy_subject_kv_writes as number,
    updated_at: candidate.updated_at as number,
  }
}

function dateAtOffset(date: string, offsetDays: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day))
  value.setUTCDate(value.getUTCDate() + offsetDays)
  return value.toISOString().slice(0, 10)
}

export async function updateShadowStreak(
  store: ShadowGateD1,
  equal: boolean,
  diffSummary: string | null,
  now: number,
): Promise<ShadowStreakV1> {
  const previous = await store.getAppState(migrateShadowStreakKey(), decodeShadowStreak)
  const next: ShadowStreakV1 = equal
    ? {
        streak: (previous?.streak ?? 0) + 1,
        last_success_at: now,
        last_diff_summary: null,
        updated_at: now,
      }
    : {
        streak: 0,
        last_success_at: previous?.last_success_at ?? null,
        last_diff_summary: diffSummary,
        updated_at: now,
      }
  await store.putAppStateIfNewer(migrateShadowStreakKey(), next, now)
  return next
}

export async function recordDailyKvBudget(
  store: ShadowGateD1,
  date: string,
  legacySubjectKvWrites: number,
  now: number,
): Promise<KvBudgetDailyV1> {
  const value: KvBudgetDailyV1 = {
    date,
    legacy_subject_kv_writes: legacySubjectKvWrites,
    updated_at: now,
  }
  await store.putAppStateIfNewer(migrateKvBudgetDailyKey(date), value, now)
  return value
}

export async function shadowGatePassed(
  store: ShadowGateD1,
  date: string,
  now: number,
): Promise<boolean> {
  const streak = await store.getAppState(migrateShadowStreakKey(), decodeShadowStreak)
  if (!streak || streak.streak < REQUIRED_SHADOW_STREAK) return false
  for (let offset = 0; offset < REQUIRED_SHADOW_STREAK; offset++) {
    const day = dateAtOffset(date, -offset)
    const budget = await store.getAppState(migrateKvBudgetDailyKey(day), decodeKvBudgetDaily)
    if (!budget || budget.legacy_subject_kv_writes > MAX_LEGACY_KV_WRITES_PER_DAY) return false
  }
  return true
}

export async function switchReadMode(
  store: ShadowGateD1,
  kv: ReadModeKv,
  now: number,
): Promise<ReadModeV1> {
  const next: ReadModeV1 = { mode: 'r2', switched_at: now }
  await store.putAppStateIfNewer(migrateReadModeKey(), next, now)
  try {
    await kv.put(PUBLIC_READ_MODE_KV_KEY, canonicalJson(next))
  } catch {
    // The D1 authority is already advanced; the next scheduled run retries the mirror.
  }
  return next
}

export async function rollbackReadMode(
  store: ShadowGateD1,
  kv: ReadModeKv,
  now: number,
): Promise<ReadModeV1> {
  const next: ReadModeV1 = { mode: 'legacy', switched_at: null }
  await store.putAppStateIfNewer(migrateReadModeKey(), next, now)
  try {
    await kv.put(PUBLIC_READ_MODE_KV_KEY, canonicalJson(next))
  } catch {
    // The D1 authority is already rolled back; the next scheduled run retries the mirror.
  }
  return next
}
