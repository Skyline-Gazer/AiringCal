import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { FilesystemPublicStore, planPublicSnapshotGc } from '@airing-cal/v3-core'

function readPublicRoot(env: Record<string, string | undefined>): string {
  const root = env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim() || env.AIRINGCAL_PUBLIC_READ_DIR?.trim()
  if (!root) {
    throw new Error('AIRINGCAL_BUILDER_PUBLIC_DIR or AIRINGCAL_PUBLIC_READ_DIR is required')
  }
  return root
}

function listSnapshotKeys(publicRoot: string): string[] {
  const dir = join(publicRoot, 'snapshots/v1')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => `snapshots/v1/${name}`)
}

function readPinnedRefs(env: Record<string, string | undefined>): Set<string> {
  const raw = env.AIRINGCAL_GC_PINNED?.trim()
  if (!raw) return new Set()
  return new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))
}

export async function runPortablePublicGc(
  env: Record<string, string | undefined> = process.env,
  apply = false,
): Promise<{ plan: ReturnType<typeof planPublicSnapshotGc>; applied: number }> {
  const publicRoot = readPublicRoot(env)
  const store = new FilesystemPublicStore(publicRoot)
  const minGenerations = Number(env.AIRINGCAL_GC_MIN_GENERATIONS?.trim() || '5')
  const snapshotKeys = listSnapshotKeys(publicRoot)
  const current = await store.getCurrentRelease()
  const plan = planPublicSnapshotGc({
    snapshotKeys,
    currentArtifactRef: current?.artifact_ref ?? null,
    pinnedArtifactRefs: readPinnedRefs(env),
    minGenerations,
  })
  let applied = 0
  if (apply) {
    for (const key of plan.delete) {
      unlinkSync(store.resolveObjectPath(key))
      applied += 1
    }
  }
  return { plan, applied }
}

if (process.argv[1]?.endsWith('portable-public-gc.ts')) {
  const apply = process.argv.includes('--apply')
  runPortablePublicGc(process.env, apply)
    .then(({ plan, applied }) => {
      console.log(JSON.stringify({
        status: apply ? 'applied' : 'dry_run',
        stage: 'public_snapshot_gc',
        keep: plan.keep,
        delete: plan.delete,
        applied,
      }))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'gc_failed'
      console.error(JSON.stringify({ status: 'failed', stage: 'public_snapshot_gc', message }))
      process.exit(1)
    })
}
