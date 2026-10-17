import { readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parsePublicSnapshotV1 } from '@airing-cal/domain'
import {
  collectReferencedImageHashes,
  FilesystemPublicStore,
  planPublicImageGc,
  planPublicSnapshotGc,
} from '@airing-cal/v3-core'

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

function readPublishedAtUnixByKey(publicRoot: string, snapshotKeys: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const key of snapshotKeys) {
    try {
      const raw = readFileSync(join(publicRoot, key), 'utf8')
      const parsed = JSON.parse(raw) as { published_at?: unknown }
      if (typeof parsed.published_at === 'number' && Number.isSafeInteger(parsed.published_at)) {
        map.set(key, parsed.published_at)
      }
    } catch {
      // ignore unreadable snapshots during planning
    }
  }
  return map
}

function readPinnedRefs(env: Record<string, string | undefined>): Set<string> {
  const raw = env.AIRINGCAL_GC_PINNED?.trim()
  if (!raw) return new Set()
  return new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))
}

function readPinnedImageHashes(env: Record<string, string | undefined>): Set<string> {
  const raw = env.AIRINGCAL_GC_PINNED_IMAGES?.trim()
  if (!raw) return new Set()
  return new Set(raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean))
}

function listImageHashDirs(publicRoot: string): string[] {
  const dir = join(publicRoot, 'images')
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export async function planPortablePublicImageGc(
  env: Record<string, string | undefined> = process.env,
): Promise<ReturnType<typeof planPublicImageGc> | null> {
  const publicRoot = readPublicRoot(env)
  const store = new FilesystemPublicStore(publicRoot)
  const pointer = await store.getCurrentRelease()
  if (!pointer) return null
  const bytes = await store.getSnapshotBytes(pointer.artifact_ref)
  if (!bytes) return null
  const snapshot = await parsePublicSnapshotV1(JSON.parse(new TextDecoder().decode(bytes)))
  return planPublicImageGc({
    onDiskHashes: listImageHashDirs(publicRoot),
    referencedHashes: collectReferencedImageHashes(snapshot),
    pinnedHashes: readPinnedImageHashes(env),
  })
}

export async function runPortablePublicImageGc(
  env: Record<string, string | undefined> = process.env,
  apply = false,
): Promise<{ plan: ReturnType<typeof planPublicImageGc> | null; applied: number }> {
  const plan = await planPortablePublicImageGc(env)
  if (!plan) return { plan: null, applied: 0 }
  let applied = 0
  if (apply) {
    applied = applyPublicImageGcPlan(readPublicRoot(env), plan)
  }
  return { plan, applied }
}

export function applyPublicImageGcPlan(
  publicRoot: string,
  plan: ReturnType<typeof planPublicImageGc>,
): number {
  let applied = 0
  for (const hash of plan.delete) {
    rmSync(join(publicRoot, 'images', hash), { recursive: true, force: true })
    applied += 1
  }
  return applied
}

export async function logPublicImageGcDryRun(
  env: Record<string, string | undefined> = process.env,
): Promise<ReturnType<typeof planPublicImageGc> | null> {
  const plan = await planPortablePublicImageGc(env)
  if (!plan) return null
  console.log(JSON.stringify({
    status: 'info',
    stage: 'public_image_gc_dry_run',
    keep_count: plan.keep.length,
    delete_count: plan.delete.length,
    delete: plan.delete,
  }))
  return plan
}

export async function logPublicSnapshotGcDryRun(
  env: Record<string, string | undefined> = process.env,
): Promise<ReturnType<typeof planPublicSnapshotGc>> {
  const { plan } = await runPortablePublicGc(env, false)
  console.log(JSON.stringify({
    status: 'info',
    stage: 'public_snapshot_gc_dry_run',
    keep_count: plan.keep.length,
    delete_count: plan.delete.length,
    delete: plan.delete,
  }))
  try {
    await logPublicImageGcDryRun(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'image_gc_dry_run_failed'
    console.log(JSON.stringify({ status: 'info', stage: 'public_image_gc_dry_run', error: message }))
  }
  return plan
}

export async function runPortablePublicGc(
  env: Record<string, string | undefined> = process.env,
  apply = false,
): Promise<{ plan: ReturnType<typeof planPublicSnapshotGc>; applied: number }> {
  const publicRoot = readPublicRoot(env)
  const store = new FilesystemPublicStore(publicRoot)
  const minGenerations = Number(env.AIRINGCAL_GC_MIN_GENERATIONS?.trim() || '5')
  const minAgeDays = Number(env.AIRINGCAL_GC_MIN_AGE_DAYS?.trim() || '30')
  const snapshotKeys = listSnapshotKeys(publicRoot)
  const current = await store.getCurrentRelease()
  const plan = planPublicSnapshotGc({
    snapshotKeys,
    currentArtifactRef: current?.artifact_ref ?? null,
    pinnedArtifactRefs: readPinnedRefs(env),
    minGenerations,
    minAgeDays,
    publishedAtUnixByKey: readPublishedAtUnixByKey(publicRoot, snapshotKeys),
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

async function main(): Promise<void> {
  const applySnapshots = process.argv.includes('--apply')
  const applyImages = process.argv.includes('--apply-images')
  if (applySnapshots) {
    const { plan, applied } = await runPortablePublicGc(process.env, true)
    console.log(JSON.stringify({
      status: 'applied',
      stage: 'public_snapshot_gc',
      keep: plan.keep,
      delete: plan.delete,
      applied,
    }))
  } else if (!applyImages) {
    const { plan } = await runPortablePublicGc(process.env, false)
    console.log(JSON.stringify({
      status: 'dry_run',
      stage: 'public_snapshot_gc',
      keep: plan.keep,
      delete: plan.delete,
      applied: 0,
    }))
  }
  if (applyImages) {
    const { plan, applied } = await runPortablePublicImageGc(process.env, true)
    console.log(JSON.stringify({
      status: 'applied',
      stage: 'public_image_gc',
      keep: plan?.keep ?? [],
      delete: plan?.delete ?? [],
      applied,
    }))
  } else if (!applySnapshots) {
    const plan = await planPortablePublicImageGc(process.env)
    console.log(JSON.stringify({
      status: 'dry_run',
      stage: 'public_image_gc',
      keep: plan?.keep ?? [],
      delete: plan?.delete ?? [],
      applied: 0,
    }))
  }
}

if (process.argv[1]?.endsWith('portable-public-gc.ts')) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'gc_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'public_gc', message }))
    process.exit(1)
  })
}
