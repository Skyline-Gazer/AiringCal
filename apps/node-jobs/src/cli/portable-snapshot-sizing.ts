import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { parsePublicSnapshotV1 } from '@airing-cal/domain'

/**
 * Split-json decision guard from ADR 0001 (#69/#71): a single JSON snapshot is
 * used while its gzip size stays below this bound (the 48-item synthetic fixture
 * is ~40.7 KiB compact, far under). If a real anonymized production export
 * exceeds it, revisit splitting — see
 * `docs/v3/adr-0001-release-contract-and-adapters.md` (#5).
 */
export const SINGLE_SNAPSHOT_GZIP_LIMIT_BYTES = 500 * 1024

export interface SnapshotSizingReport {
  compact_bytes: number
  gzip_bytes: number
  sections_kib: Record<string, { bytes: number; percent: number }>
  items: {
    collections: number
    calendar: number
  }
  single_json_viable: boolean
}

function sectionSizes(snapshot: Record<string, unknown>): Record<string, { bytes: number; percent: number }> {
  const totals: Record<string, number> = {}
  for (const key of Object.keys(snapshot)) {
    totals[key] = JSON.stringify(snapshot[key]).length
  }
  const total = Object.values(totals).reduce((sum, size) => sum + size, 0) || 1
  const out: Record<string, { bytes: number; percent: number }> = {}
  for (const [key, size] of Object.entries(totals)) {
    out[key] = { bytes: size, percent: Number(((size / total) * 100).toFixed(1)) }
  }
  return out
}

export async function measureSnapshotSizing(jsonPath: string): Promise<SnapshotSizingReport> {
  const raw = readFileSync(jsonPath, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const snapshot = await parsePublicSnapshotV1(parsed)
  const compactJson = JSON.stringify(parsed)
  const gzipBytes = gzipSync(compactJson).length

  const itemCount = Object.values(snapshot.collections).reduce((sum, bucket) => sum + bucket.length, 0)
  return {
    compact_bytes: compactJson.length,
    gzip_bytes: gzipBytes,
    sections_kib: sectionSizes(parsed),
    items: {
      collections: itemCount,
      calendar: snapshot.calendar.reduce((sum, day) => sum + day.items.length, 0),
    },
    single_json_viable: gzipBytes < SINGLE_SNAPSHOT_GZIP_LIMIT_BYTES,
  }
}

if (process.argv[1]?.endsWith('portable-snapshot-sizing.ts')) {
  void (async () => {
    const jsonPath = process.argv[2]
    try {
      if (!jsonPath) {
        throw new Error('Usage: portable-snapshot-sizing.ts <public-snapshot.json>')
      }
      const report = await measureSnapshotSizing(jsonPath)
      console.log(JSON.stringify({
        status: 'ok',
        stage: 'snapshot_sizing',
        report,
        limit_bytes: SINGLE_SNAPSHOT_GZIP_LIMIT_BYTES,
        note: report.single_json_viable
          ? 'single JSON snapshot is viable'
          : 'single JSON may be too large — revisit split decision (ADR 0001)',
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sizing_failed'
      console.error(JSON.stringify({ status: 'failed', stage: 'snapshot_sizing', message }))
      process.exit(1)
    }
  })()
}
