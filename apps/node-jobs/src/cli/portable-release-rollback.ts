import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parsePublicSnapshotManifestV1, parsePublicSnapshotV1 } from '@airing-cal/domain'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import { FilesystemPublicStore, type PublicReleasePointer, type PublicStore } from '@airing-cal/v3-core'
import type { ConditionalObjectStore } from '../adapters/object-store.ts'
import { readCheckpointS3Config, readPublicS3Config } from '../adapters/s3-env.ts'
import { createS3ObjectStore } from '../adapters/s3-object-store.ts'
import { S3CompatiblePublicStore } from '../adapters/s3-public-store.ts'
import {
  acquireCheckpointLease,
  releaseCheckpointLease,
} from '../adapters/s3-checkpoint-store.ts'
import { ensurePublishImagesComplete, type PublishImageGateResult } from '../sync/publish-image-gate.ts'

export const ROLLBACK_RESUME_RULE =
  'Resume rule: keep AIRINGCAL_WRITER_ENABLED=false until the owner records how the SQLite checkpoint converges with the rolled-back Release — restore/rebuild the checkpoint to match the rolled-back generation, or approve a deliberate republish of newer state after review. See docs/v3/cutover-rollback.md.'

export interface RollbackTarget {
  current: PublicReleasePointer
  artifact_ref: string
  snapshot: PublicSnapshotV1
  manifest_ref: string | null
  /** Publish image gate over the target snapshot (existence proof for every referenced image). */
  image_gate: PublishImageGateResult
}

/**
 * A receipt path is an audit requirement: validate it before the pointer commit so a
 * typo cannot apply a rollback and then lose the receipt. Returns an absolute path.
 */
export function assertReceiptWritable(receiptPath: string | null): string | null {
  if (!receiptPath) return null
  const resolved = resolve(receiptPath)
  const directory = dirname(resolved)
  if (!existsSync(directory)) {
    throw new Error(`--receipt directory does not exist: ${directory}`)
  }
  return resolved
}


export interface RollbackReceipt {
  schema_version: 1
  action: 'release_pointer_rollback'
  executed_at: string
  dry_run: boolean
  writer_frozen_attested: boolean
  checkpoint_lease: { checked: boolean; status: string; holder?: string }
  prior_pointer: PublicReleasePointer | null
  target_generation: number
  target_artifact_ref: string
  target_manifest_ref: string | null
  target_pointer: PublicReleasePointer
  image_gate: PublishImageGateResult
  cas_result: 'committed' | 'conflict' | 'not_attempted'
  resume_rule: string
}

export interface ReleaseRollbackDeps {
  publicStore: PublicStore
  /** Private checkpoint store (S3). When present the rollback takes the writer lease to fence in-flight runs. */
  checkpointStore?: ConditionalObjectStore | null
  nowUnix?: number
  nowIso?: () => string
}

export interface RollbackOptions {
  apply: boolean
  /** Operator attestation that AIRINGCAL_WRITER_ENABLED=false and no production writer run is scheduled. */
  writerFrozenAttested: boolean
}

/**
 * List object keys under a prefix using whatever the store offers: S3-compatible
 * stores expose `objects.list`, filesystem stores are walked with readdir. Pointer
 * history is derived from the generation-scoped snapshot/manifest keys already in
 * the store — no separate state service.
 */
export async function listObjectKeys(store: PublicStore, prefix: string): Promise<string[]> {
  if (store instanceof FilesystemPublicStore) {
    const dirIndex = prefix.lastIndexOf('/')
    const dirPart = prefix.slice(0, dirIndex + 1)
    const nameFilter = prefix.slice(dirIndex + 1)
    const base = store.resolveObjectPath(dirPart)
    let entries: string[]
    try {
      entries = readdirSync(base, { withFileTypes: true }).map((entry) => entry.name)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter((name) => name.startsWith(nameFilter) && name.endsWith('.json'))
      .map((name) => `${dirPart}${name}`)
      .sort()
  }
  if (store instanceof S3CompatiblePublicStore) {
    if (!store.objects.list) {
      throw new Error('Object store does not support listing; rollback needs S3 ListObjectsV2 or a filesystem store')
    }
    return store.objects.list(prefix)
  }
  throw new Error('Public store does not support listing; rollback needs an S3-compatible or filesystem store')
}

/** Parse snapshot bytes and verify the object key carries the snapshot's generation + content hash. */
async function parseSnapshotAt(key: string, bytes: Uint8Array): Promise<PublicSnapshotV1> {
  const parsed = await parsePublicSnapshotV1(JSON.parse(new TextDecoder().decode(bytes)))
  if (!key.endsWith(`/${parsed.generation}-${parsed.content_hash}.json`)) {
    throw new Error(`Snapshot object ${key} disagrees with its generation/content hash`)
  }
  return parsed
}

/**
 * Resolve a rollback target generation from the generation-scoped snapshot keys in
 * the store. Verifies the snapshot bytes, the referenced images (publish gate,
 * fail closed), and the versioned manifest. Returns null when no current release
 * pointer exists (nothing to roll back from).
 */
export async function resolveRollbackTarget(
  deps: ReleaseRollbackDeps,
  targetGeneration: number,
): Promise<RollbackTarget | null> {
  const current = await deps.publicStore.getCurrentRelease()
  if (!current) return null
  if (!Number.isSafeInteger(targetGeneration) || targetGeneration < 0) {
    throw new Error(`Invalid target generation: ${targetGeneration}`)
  }
  if (targetGeneration >= current.generation) {
    throw new Error(
      `Refusing to roll back: target generation ${targetGeneration} must be lower than current generation ${current.generation}`,
    )
  }
  const snapshotPrefix = `snapshots/v1/${targetGeneration}-`
  const keys = (await listObjectKeys(deps.publicStore, snapshotPrefix)).filter((key) => key.endsWith('.json'))
  if (keys.length !== 1) {
    throw new Error(
      `Expected exactly one snapshot object for generation ${targetGeneration}, found ${keys.length}${keys.length ? `: ${keys.join(', ')}` : ''}`,
    )
  }
  const artifactRef = keys[0]
  const bytes = await deps.publicStore.getSnapshotBytes(artifactRef)
  if (!bytes) {
    throw new Error(`Rollback target snapshot ${artifactRef} is unreadable in the public store`)
  }
  const snapshot = await parseSnapshotAt(artifactRef, bytes)
  if (snapshot.generation !== targetGeneration) {
    throw new Error(`Snapshot ${artifactRef} declares generation ${snapshot.generation}`)
  }

  // Every referenced image must already be readable in the public store — rollback
  // has no local image root. Originals are fatal when missing; thumbs are optional.
  const imageGate = await ensurePublishImagesComplete({
    snapshot,
    publicStore: deps.publicStore,
    imageRoot: null,
  })

  const manifestPrefix = `public/manifests/${targetGeneration}-`
  const manifestKeys = await listObjectKeys(deps.publicStore, manifestPrefix)
  let manifestRef: string | null = null
  for (const key of manifestKeys) {
    const manifestBytes = await deps.publicStore.getSnapshotBytes(key)
    if (!manifestBytes) continue
    let manifest: ReturnType<typeof parsePublicSnapshotManifestV1>
    try {
      manifest = parsePublicSnapshotManifestV1(JSON.parse(new TextDecoder().decode(manifestBytes)))
    } catch {
      continue
    }
    const matches =
      manifest.generation === snapshot.generation
      && manifest.content_sha256 === snapshot.content_hash
      && manifest.snapshot_key === artifactRef
    if (!matches) continue
    if (manifestRef) {
      throw new Error(`Ambiguous manifest objects for generation ${targetGeneration}: ${manifestRef} and ${key}`)
    }
    manifestRef = key
  }
  if (!manifestRef) {
    // Pre-C1 generation fallback: C1 readers hard-fail when a manifest_ref disagrees,
    // and legacy pointers fall back to the single mutable public/manifest.json — only
    // allow the fallback when that object is absent or verifiably belongs to the target.
    const legacyBytes = await deps.publicStore.getSnapshotBytes('public/manifest.json')
    let legacyOk = false
    if (legacyBytes) {
      try {
        const legacy = parsePublicSnapshotManifestV1(JSON.parse(new TextDecoder().decode(legacyBytes)))
        legacyOk =
          legacy.generation === snapshot.generation
          && legacy.content_sha256 === snapshot.content_hash
          && legacy.snapshot_key === artifactRef
      } catch {
        legacyOk = false
      }
    }
    if (!legacyOk) {
      throw new Error(
        `No versioned manifest object for generation ${targetGeneration} and public/manifest.json does not describe it; refusing rollback to a release readers cannot verify`,
      )
    }
  }

  return { current, artifact_ref: artifactRef, snapshot, manifest_ref: manifestRef, image_gate: imageGate }
}

export function buildRollbackPointer(target: RollbackTarget): PublicReleasePointer {
  return {
    schema_version: 1,
    generation: target.snapshot.generation,
    content_hash: target.snapshot.content_hash,
    published_at_unix: target.snapshot.published_at,
    artifact_ref: target.artifact_ref,
    ...(target.manifest_ref ? { manifest_ref: target.manifest_ref } : {}),
  }
}

/**
 * C9: CAS the public release pointer back to a chosen prior generation.
 * Requires the writer-freeze attestation before any commit, refuses when the
 * checkpoint lease shows an in-flight writer, verifies the target (images +
 * manifest), records prior pointer + target generation in the receipt, and
 * documents the resume/convergence rule. Dry run (apply=false) never touches
 * the pointer.
 */
export async function rollbackReleasePointer(
  deps: ReleaseRollbackDeps,
  targetGeneration: number,
  options: RollbackOptions,
): Promise<RollbackReceipt> {
  const executedAt = deps.nowIso?.() ?? new Date().toISOString()
  if (options.apply && !options.writerFrozenAttested) {
    throw new Error(
      'Refusing to roll back: writer freeze not attested. Freeze the writer first (AIRINGCAL_WRITER_ENABLED=false) and pass --writer-frozen.',
    )
  }

  const leaseOwner = `rollback-${executedAt}`
  let lease: Awaited<ReturnType<typeof acquireCheckpointLease>> | null = null
  try {
    if (deps.checkpointStore) {
      const nowUnix = deps.nowUnix ?? Math.floor(Date.now() / 1000)
      lease = await acquireCheckpointLease(deps.checkpointStore, {
        ownerToken: leaseOwner,
        nowUnix,
        ttlSeconds: 900,
      })
      if (lease.status === 'held') {
        throw new Error(
          `An in-flight writer run may be active: checkpoint lease held by ${lease.holder} until ${lease.expires_at_unix}. Freeze the writer and wait for the run to exit before rolling back.`,
        )
      }
    }

    const target = await resolveRollbackTarget(deps, targetGeneration)
    if (!target) {
      throw new Error('No current release pointer in the public store; nothing to roll back from')
    }
    const targetPointer = buildRollbackPointer(target)
    let casResult: RollbackReceipt['cas_result'] = 'not_attempted'
    if (options.apply) {
      const commit = await deps.publicStore.commitRelease(target.current, targetPointer)
      if (commit !== 'committed') {
        throw new Error(`Pointer CAS ${commit}: the current release pointer changed during rollback; re-run after re-checking the pointer`)
      }
      casResult = 'committed'
    }
    return {
      schema_version: 1,
      action: 'release_pointer_rollback',
      executed_at: executedAt,
      dry_run: !options.apply,
      writer_frozen_attested: options.writerFrozenAttested,
      checkpoint_lease: {
        checked: deps.checkpointStore != null,
        status: lease?.status ?? 'not_checked',
      },
      prior_pointer: target.current,
      target_generation: target.snapshot.generation,
      target_artifact_ref: target.artifact_ref,
      target_manifest_ref: target.manifest_ref,
      target_pointer: targetPointer,
      image_gate: target.image_gate,
      cas_result: casResult,
      resume_rule: ROLLBACK_RESUME_RULE,
    }
  } finally {
    if (deps.checkpointStore && lease && lease.status === 'acquired') {
      await releaseCheckpointLease(deps.checkpointStore, leaseOwner)
    }
  }
}

function readArg(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] ?? null : null
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const writerFrozenAttested = argv.includes('--writer-frozen')
  const receiptPath = readArg(argv, '--receipt')
  const generation = Number(readArg(argv, '--generation'))
  if (!Number.isSafeInteger(generation) || generation < 0) {
    console.error(JSON.stringify({ status: 'failed', message: 'Usage: portable-release-rollback.ts --generation <n> [--apply] [--writer-frozen] [--receipt <path>]' }))
    process.exit(1)
  }
  if (apply && !writerFrozenAttested) {
    console.error(JSON.stringify({ status: 'failed', message: '--apply requires --writer-frozen (attests AIRINGCAL_WRITER_ENABLED=false and no in-flight production writer run)' }))
    process.exit(1)
  }
  if (apply && process.env.AIRINGCAL_WRITER_ENABLED === 'true') {
    console.error(JSON.stringify({ status: 'failed', message: 'AIRINGCAL_WRITER_ENABLED=true contradicts a rollback; freeze the writer first' }))
    process.exit(1)
  }

  let resolvedReceiptPath: string | null
  try {
    resolvedReceiptPath = assertReceiptWritable(receiptPath)
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      stage: 'receipt_preflight',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exit(1)
  }
  const publicS3 = readPublicS3Config(process.env)
  let publicStore: PublicStore
  let close: (() => void) | null = null
  if (publicS3) {
    const objects = createS3ObjectStore(publicS3)
    publicStore = new S3CompatiblePublicStore(objects)
    close = () => objects.close()
  } else {
    const publicDir = process.env.AIRINGCAL_BUILDER_PUBLIC_DIR?.trim() || process.env.AIRINGCAL_PUBLIC_READ_DIR?.trim()
    if (!publicDir) {
      console.error(JSON.stringify({
        status: 'failed',
        message: 'Configure AIRINGCAL_PUBLIC_S3_* or AIRINGCAL_BUILDER_PUBLIC_DIR; rollback never runs against a memory store',
      }))
      process.exit(1)
    }
    publicStore = new FilesystemPublicStore(publicDir)
  }
  const checkpointS3 = readCheckpointS3Config(process.env)
  const checkpointStore = checkpointS3 ? createS3ObjectStore(checkpointS3) : null

  try {
    const receipt = await rollbackReleasePointer(
      { publicStore, checkpointStore },
      generation,
      { apply, writerFrozenAttested },
    )
    console.log(JSON.stringify(receipt, null, 2))
    if (resolvedReceiptPath) writeFileSync(resolvedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    if (receipt.cas_result === 'conflict') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      stage: 'release_pointer_rollback',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  } finally {
    close?.()
  }
}

if (process.argv[1]?.endsWith('portable-release-rollback.ts')) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
