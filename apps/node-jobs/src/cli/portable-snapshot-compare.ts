import { readFileSync } from 'node:fs'
import { parsePublicSnapshotV1 } from '@airing-cal/domain'
import { compareShadowSnapshots, normalizePublicResult } from '@airing-cal/storage'

export async function comparePortableSnapshotFiles(leftPath: string, rightPath: string): Promise<{
  equal: boolean
  diffs: string[]
}> {
  const left = await parsePublicSnapshotV1(JSON.parse(readFileSync(leftPath, 'utf8')))
  const right = await parsePublicSnapshotV1(JSON.parse(readFileSync(rightPath, 'utf8')))
  return compareShadowSnapshots(normalizePublicResult(left), normalizePublicResult(right))
}

if (process.argv[1]?.endsWith('portable-snapshot-compare.ts')) {
  const left = process.argv[2]
  const right = process.argv[3]
  void (async () => {
  try {
    if (!left || !right) {
      throw new Error('Usage: portable-snapshot-compare.ts <left.json> <right.json>')
    }
    const result = await comparePortableSnapshotFiles(left, right)
    console.log(JSON.stringify({ status: result.equal ? 'equal' : 'diff', stage: 'snapshot_compare', ...result }))
    if (!result.equal) process.exit(2)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'compare_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'snapshot_compare', message }))
    process.exit(1)
  }
  })()
}
