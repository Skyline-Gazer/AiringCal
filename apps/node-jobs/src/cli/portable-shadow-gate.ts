import { readFileSync } from 'node:fs'
import {
  compareShadowSnapshots,
  migrateShadowStreakKey,
  type LegacyHydration,
  type ShadowStreakV1,
} from '@airing-cal/storage'
import { openBuilderDatabase, SqliteBuilderStateStore } from '@airing-cal/v3-builder'
import { normalizeV2PublicExport } from './portable-v2-public-normalize.ts'

/** Consecutive daily shadow matches required before a cutover is permitted (#73). */
export const REQUIRED_SHADOW_MATCHES = 7
const MAX_STORED_DIFFS = 20

export interface ShadowGateOptions {
  sqlitePath: string
  /** Legacy side: v2 R2 snapshot JSON or legacy public result (+ optional hydration sidecar). */
  legacyPayload: unknown
  hydrated?: Record<number, LegacyHydration>
  /** Current published `PublicSnapshotV1` JSON. */
  candidatePayload: unknown
  now?: () => number
}

export interface ShadowGateResult {
  equal: boolean
  diffs: string[]
  diff_count: number
  streak: ShadowStreakV1
  required_matches: number
  cutover_allowed: boolean
}

/** Returns null for a corrupt streak record so the gate restarts counting instead of trusting it. */
function parseShadowStreak(raw: string): ShadowStreakV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<ShadowStreakV1>
    if (!Number.isSafeInteger(value.streak) || (value.streak ?? -1) < 0) return null
    if (!Number.isSafeInteger(value.updated_at)) return null
    if (value.last_success_at !== null && !Number.isSafeInteger(value.last_success_at)) return null
    if (value.last_diff_summary !== null && typeof value.last_diff_summary !== 'string') return null
    return value as ShadowStreakV1
  } catch {
    return null
  }
}

function emptyStreak(nowSec: number): ShadowStreakV1 {
  return { streak: 0, last_success_at: null, last_diff_summary: null, updated_at: nowSec }
}

/**
 * Shadow-equivalence gate: compares the normalized legacy export with the
 * published snapshot, persists the consecutive-match streak in `builder_kv`
 * (`migrate:shadow:streak`) and reports whether a cutover is permitted.
 *
 * Read-only with respect to the public store: the only write is the streak
 * record, so aborting or re-running cannot affect published releases.
 */
export async function runShadowGate(options: ShadowGateOptions): Promise<ShadowGateResult> {
  const nowSec = Math.floor((options.now ?? Date.now)() / 1000)
  const legacy = await normalizeV2PublicExport(options.legacyPayload, options.hydrated)
  const candidate = await normalizeV2PublicExport(options.candidatePayload)
  const { equal, diffs } = compareShadowSnapshots(legacy, candidate)

  const db = openBuilderDatabase(options.sqlitePath)
  try {
    const state = new SqliteBuilderStateStore(db)
    const raw = await state.getKv(migrateShadowStreakKey())
    const previous = (raw ? parseShadowStreak(raw) : null) ?? emptyStreak(nowSec)
    const streak: ShadowStreakV1 = equal
      ? {
          streak: previous.streak + 1,
          last_success_at: nowSec,
          last_diff_summary: null,
          updated_at: nowSec,
        }
      : {
          streak: 0,
          last_success_at: previous.last_success_at,
          last_diff_summary: JSON.stringify(diffs.slice(0, MAX_STORED_DIFFS)),
          updated_at: nowSec,
        }
    await state.setKv(migrateShadowStreakKey(), JSON.stringify(streak))
    return {
      equal,
      diffs,
      diff_count: diffs.length,
      streak,
      required_matches: REQUIRED_SHADOW_MATCHES,
      cutover_allowed: equal && streak.streak >= REQUIRED_SHADOW_MATCHES,
    }
  } finally {
    db.close()
  }
}

export interface ShadowGateCliArgs {
  sqlitePath?: string
  legacyPath?: string
  candidatePath?: string
  hydratedPath?: string
  reset: boolean
}

export function parseShadowGateArgs(
  argv: string[],
): ShadowGateCliArgs & { sqlitePath: string } {
  const args: ShadowGateCliArgs = { reset: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--reset') {
      args.reset = true
      continue
    }
    if (['--sqlite', '--legacy', '--candidate', '--hydrated'].includes(arg)) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      if (arg === '--sqlite') args.sqlitePath = value
      if (arg === '--legacy') args.legacyPath = value
      if (arg === '--candidate') args.candidatePath = value
      if (arg === '--hydrated') args.hydratedPath = value
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }
  const sqlitePath = args.sqlitePath
  if (!sqlitePath) throw new Error('--sqlite <path> is required')
  return { ...args, sqlitePath }
}

/** Clears the persisted streak; the gate then requires a fresh run of matches. */
export async function resetShadowStreak(sqlitePath: string): Promise<void> {
  const db = openBuilderDatabase(sqlitePath)
  try {
    await new SqliteBuilderStateStore(db).setKv(migrateShadowStreakKey(), JSON.stringify({
      streak: 0,
      last_success_at: null,
      last_diff_summary: null,
      updated_at: Math.floor(Date.now() / 1000),
    }))
  } finally {
    db.close()
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readHydrated(path: string | undefined): Record<number, LegacyHydration> | undefined {
  if (!path) return undefined
  const parsed = readJson(path)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Hydrated sidecar must be a JSON object')
  }
  return parsed as Record<number, LegacyHydration>
}

if (process.argv[1]?.endsWith('portable-shadow-gate.ts')) {
  void (async () => {
    try {
      const args = parseShadowGateArgs(process.argv.slice(2))
      if (args.reset) {
        await resetShadowStreak(args.sqlitePath)
        console.log(JSON.stringify({ status: 'ok', stage: 'shadow_gate_reset', sqlite: args.sqlitePath }))
        return
      }
      if (!args.legacyPath || !args.candidatePath) {
        throw new Error(
          'Usage: portable-shadow-gate.ts --sqlite <path> --legacy <legacy.json> --candidate <public-snapshot.json> '
          + '[--hydrated <sidecar.json>] [--reset]',
        )
      }
      const result = await runShadowGate({
        sqlitePath: args.sqlitePath,
        legacyPayload: readJson(args.legacyPath),
        hydrated: readHydrated(args.hydratedPath),
        candidatePayload: readJson(args.candidatePath),
      })
      console.log(JSON.stringify({
        status: 'ok',
        stage: result.cutover_allowed ? 'shadow_gate_open' : 'shadow_gate_blocked',
        equal: result.equal,
        streak: result.streak.streak,
        required_matches: result.required_matches,
        cutover_allowed: result.cutover_allowed,
        diff_count: result.diff_count,
        diffs: result.diffs.slice(0, MAX_STORED_DIFFS),
      }))
      if (!result.cutover_allowed) process.exit(2)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'shadow_gate_failed'
      console.error(JSON.stringify({ status: 'failed', stage: 'shadow_gate', message }))
      process.exit(1)
    }
  })()
}
