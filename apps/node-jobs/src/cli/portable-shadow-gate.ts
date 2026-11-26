import { readFileSync } from 'node:fs'
import {
  compareShadowSnapshots,
  migrateShadowStreakKey,
  type LegacyHydration,
} from '@airing-cal/storage'
import { openBuilderDatabase } from '@airing-cal/v3-builder'
import { normalizeV2PublicExport } from './portable-v2-public-normalize.ts'

const MAX_REPORTED_DIFFS = 20

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
}

/**
 * One-shot shadow-equivalence compare: normalizes legacy + candidate payloads and
 * returns equal/diff. Does not persist streak counters or cutover gates.
 */
export async function runShadowGate(options: ShadowGateOptions): Promise<ShadowGateResult> {
  const legacy = await normalizeV2PublicExport(options.legacyPayload, options.hydrated)
  const candidate = await normalizeV2PublicExport(options.candidatePayload)
  const { equal, diffs } = compareShadowSnapshots(legacy, candidate)
  return { equal, diffs, diff_count: diffs.length }
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

/** Deletes any leftover `migrate:shadow:streak` key; no streak rewrite. */
export async function resetShadowStreak(sqlitePath: string): Promise<void> {
  const db = openBuilderDatabase(sqlitePath)
  try {
    db.prepare('DELETE FROM builder_kv WHERE key = ?').run(migrateShadowStreakKey())
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
        stage: result.equal ? 'shadow_gate_equal' : 'shadow_gate_mismatch',
        equal: result.equal,
        diff_count: result.diff_count,
        diffs: result.diffs.slice(0, MAX_REPORTED_DIFFS),
      }))
      process.exit(result.equal ? 0 : 2)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'shadow_gate_failed'
      console.error(JSON.stringify({ status: 'failed', stage: 'shadow_gate', message }))
      process.exit(1)
    }
  })()
}
