import { buildPublicSnapshot } from '@airing-cal/domain'
import {
  buildLegacyPublicResult,
  imageStatusKey,
  normalizePublicResult,
  snapshotCalendarKey,
  snapshotCollectionsKey,
  snapshotSummaryKey,
  snapshotVersionKey,
  subjectDetailKey,
  subjectMetaKey,
  type LegacyHydration,
  type NormalizedPublicResult,
  type PublicCalendarDayV1,
  type PublicCollectionItemV1,
  type PublicSnapshotSummaryV1,
} from '@airing-cal/storage'
import type { D1SyncResult } from './d1-sync.ts'
import type { PublicationResult } from './r2-publication.ts'

const COLLECTION_TYPES = ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const
type CollectionType = typeof COLLECTION_TYPES[number]

export interface DailyShadowKv {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: unknown, options?: { expirationTtl?: number }): Promise<void>
}

async function readJson<T>(kv: DailyShadowKv, key: string): Promise<T | null> {
  const value = await kv.get(key, 'json')
  return value === null || value === undefined ? null : value as T
}

async function readSnapshotValue<T>(
  kv: DailyShadowKv,
  activeInstance: string | null,
  suffix: string,
  legacyKey: string,
): Promise<T | null> {
  if (activeInstance) {
    const versioned = await readJson<T>(kv, snapshotVersionKey(activeInstance, suffix))
    if (versioned !== null) return versioned
  }
  return readJson<T>(kv, legacyKey)
}

function cachedRef(status: unknown): { hash: string; uri: string; r2_key: string } | null {
  if (typeof status !== 'object' || status === null) return null
  const candidate = status as Record<string, unknown>
  return candidate.status === 'cached'
    && typeof candidate.hash === 'string'
    && typeof candidate.uri === 'string'
    && typeof candidate.r2_key === 'string'
    ? { hash: candidate.hash, uri: candidate.uri, r2_key: candidate.r2_key }
    : null
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

async function hydrationFor(kv: DailyShadowKv, subjectId: number): Promise<LegacyHydration> {
  const [rawStatus, rawMeta, rawDetail] = await Promise.all([
    kv.get(imageStatusKey(subjectId), 'json'),
    kv.get(subjectMetaKey(subjectId), 'json'),
    kv.get(subjectDetailKey(subjectId), 'json'),
  ])
  const hydration: LegacyHydration = {}
  const status = typeof rawStatus === 'object' && rawStatus !== null
    ? rawStatus as Record<string, unknown>
    : undefined
  if (status) {
    const common = cachedRef(status.common)
    const large = cachedRef(status.large)
    if (common || large) hydration.images = { common, large }
  }
  const meta = typeof rawMeta === 'object' && rawMeta !== null
    ? rawMeta as Record<string, unknown>
    : undefined
  if (meta && typeof meta.nsfw === 'boolean') hydration.nsfw = meta.nsfw
  const detail = typeof rawDetail === 'object' && rawDetail !== null
    ? rawDetail as { subject?: Record<string, unknown>; rating?: { score: number; rank: number; total: number } }
    : undefined
  const subject = detail?.subject
  if (subject) {
    const eps = firstPositive(subject.eps, subject.eps_count, subject.total_episodes)
    const total = firstPositive(subject.total_episodes, subject.eps, subject.eps_count)
    if (eps !== undefined) hydration.eps = eps
    if (total !== undefined) hydration.total_episodes = total
  }
  if (detail?.rating) hydration.rating = detail.rating
  return hydration
}

export async function readLegacyPublicResult(
  kv: DailyShadowKv,
  activeInstance: string | null,
): Promise<NormalizedPublicResult> {
  const collections = {} as Record<CollectionType, PublicCollectionItemV1[]>
  const subjectIds = new Set<number>()
  for (const type of COLLECTION_TYPES) {
    const items = await readSnapshotValue<PublicCollectionItemV1[]>(
      kv,
      activeInstance,
      `collections:${type}`,
      snapshotCollectionsKey(type),
    ) ?? []
    collections[type] = items
    for (const item of items) {
      if (Number.isSafeInteger(item.subject_id)) subjectIds.add(item.subject_id)
    }
  }
  const calendar = await readSnapshotValue<PublicCalendarDayV1[]>(
    kv,
    activeInstance,
    'calendar',
    snapshotCalendarKey(),
  ) ?? []
  for (const day of calendar) {
    for (const entry of day.items) {
      if (Number.isSafeInteger(entry.subject_id)) subjectIds.add(entry.subject_id)
    }
  }
  const summary = await readSnapshotValue<PublicSnapshotSummaryV1>(
    kv,
    activeInstance,
    'summary',
    snapshotSummaryKey(),
  ) ?? { want: 0, watched: 0, watching: 0, on_hold: 0, dropped: 0, _total: 0 }
  const hydrated: Record<number, LegacyHydration> = {}
  await Promise.all([...subjectIds].map(async (subjectId) => {
    hydrated[subjectId] = await hydrationFor(kv, subjectId)
  }))
  return buildLegacyPublicResult({ collections, calendar, summary }, hydrated)
}

export interface DailyShadowPhaseDeps {
  now: number
  instanceId: string
  activeInstance: string | null
  legacySubjectKvWrites: number
  runIncremental(): Promise<D1SyncResult>
  publishShadow(result: D1SyncResult): Promise<PublicationResult>
  legacyResult(): Promise<NormalizedPublicResult>
  compare(legacy: NormalizedPublicResult, r2: NormalizedPublicResult): { equal: boolean; diffs: string[] }
  updateStreak(equal: boolean, diffSummary: string | null, now: number): Promise<unknown>
  recordKvBudget(date: string, writes: number, now: number): Promise<unknown>
  gatePassed(date: string, now: number): Promise<boolean>
  promotePointer(now: number): Promise<{ promoted: boolean; generation: number }>
  switchMode(now: number): Promise<unknown>
  runCleanup(now: number): Promise<unknown>
  runMigration(now: number): Promise<unknown>
}

export interface DailyShadowPhaseResult {
  shadow_errors: string[]
}

export async function runDailyShadowPhase(
  deps: DailyShadowPhaseDeps,
): Promise<DailyShadowPhaseResult> {
  const errors: string[] = []
  const capture = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let r2Candidate: NormalizedPublicResult | null = null
  await capture('incremental', async () => {
    const result = await deps.runIncremental()
    const published = await deps.publishShadow(result)
    if (published.status === 'pending') {
      throw new Error('shadow snapshot publication remains pending')
    }
    const built = await buildPublicSnapshot(result.publicationInput, published.generation)
    r2Candidate = normalizePublicResult(built)
  })
  await capture('migration', () => deps.runMigration(deps.now))
  if (r2Candidate) {
    await capture('shadow-compare', async () => {
      const legacy = await deps.legacyResult()
      const comparison = deps.compare(legacy, r2Candidate as NormalizedPublicResult)
      await deps.updateStreak(
        comparison.equal,
        comparison.diffs.length > 0 ? comparison.diffs.join('; ').slice(0, 500) : null,
        deps.now,
      )
      const date = new Date(deps.now * 1000).toISOString().slice(0, 10)
      await deps.recordKvBudget(date, deps.legacySubjectKvWrites, deps.now)
      if (await deps.gatePassed(date, deps.now)) {
        await deps.promotePointer(deps.now)
        await deps.switchMode(deps.now)
      }
    })
  }
  await capture('cleanup', () => deps.runCleanup(deps.now))
  return { shadow_errors: errors }
}
