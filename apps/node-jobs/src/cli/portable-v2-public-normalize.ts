import { readFileSync } from 'node:fs'
import { parsePublicSnapshotV1 } from '@airing-cal/domain'
import {
  buildLegacyPublicResult,
  normalizePublicResult,
  type LegacyHydration,
  type LegacyPublicResult,
  type NormalizedPublicResult,
} from '@airing-cal/storage'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLegacyPublicResult(value: unknown): value is LegacyPublicResult {
  if (!isRecord(value) || !isRecord(value.collections) || !Array.isArray(value.calendar)) return false
  return isRecord(value.summary)
}

function parseHydratedMap(value: unknown): Record<number, LegacyHydration> {
  if (!isRecord(value)) throw new Error('hydrated sidecar must be a JSON object')
  const out: Record<number, LegacyHydration> = {}
  for (const [key, entry] of Object.entries(value)) {
    const id = Number(key)
    if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid hydrated subject id: ${key}`)
    if (!isRecord(entry)) throw new Error(`hydrated.${key} must be an object`)
    out[id] = entry as LegacyHydration
  }
  return out
}

/** Normalize v2 R2 snapshot JSON or legacy KV public result for shadow compare (#73). */
export async function normalizeV2PublicExport(
  payload: unknown,
  hydrated: Record<number, LegacyHydration> = {},
): Promise<NormalizedPublicResult> {
  if (isRecord(payload) && payload.schema_version === 1) {
    return normalizePublicResult(await parsePublicSnapshotV1(payload))
  }
  if (!isLegacyPublicResult(payload)) {
    throw new Error('Input must be PublicSnapshotV1 (schema_version 1) or legacy public result shape')
  }
  return buildLegacyPublicResult(payload, hydrated)
}

export function loadJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

if (process.argv[1]?.endsWith('portable-v2-public-normalize.ts')) {
  const inputPath = process.argv[2]
  const hydratedPath = process.argv[3]
  void (async () => {
    try {
      if (!inputPath) {
        throw new Error('Usage: portable-v2-public-normalize.ts <public.json> [hydrated.json]')
      }
      const hydrated = hydratedPath ? parseHydratedMap(loadJsonFile(hydratedPath)) : {}
      const normalized = await normalizeV2PublicExport(loadJsonFile(inputPath), hydrated)
      console.log(JSON.stringify({ status: 'ok', stage: 'v2_public_normalize', normalized }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'normalize_failed'
      console.error(JSON.stringify({ status: 'failed', stage: 'v2_public_normalize', message }))
      process.exit(1)
    }
  })()
}
