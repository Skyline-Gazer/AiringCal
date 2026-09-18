import {
  canonicalSnapshotBytes,
  parsePublicSnapshotManifestV1,
  parsePublicSnapshotV1,
  type PublicSnapshotManifestV1,
} from '@airing-cal/domain'
import { canonicalJson } from '@airing-cal/storage'
import {
  restoreVerify,
  type RestoreDependencies,
  type RestoreReport,
} from '../backup/restore.js'

export const LIVE_MANIFEST_KEY = 'public/manifest.json'
export const SHADOW_MANIFEST_KEY = 'shadow/manifest.json'

export interface MigrationStoragePort {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, bytes: Uint8Array): Promise<void>
}

export type FieldDifference = {
  path: string
  expected: unknown
  actual: unknown
}

export type MigrationStatus = 'dry_run' | 'executed'

export type VerifiedManifest = {
  key: typeof LIVE_MANIFEST_KEY | typeof SHADOW_MANIFEST_KEY
  bytes: Uint8Array
  snapshotBytes: Uint8Array
  manifest: PublicSnapshotManifestV1
  verified: boolean
}

export type ShadowCompareRequest = {
  snapshotKey: string
  snapshotBytes: Uint8Array
  manifestBytes: Uint8Array
  live: unknown
  shadow: unknown
  dryRun?: boolean
}

export type ShadowCompareResult = {
  operation: 'shadow-compare'
  status: MigrationStatus
  namespace: 'shadow'
  writes: string[]
  equal: boolean
  differences: FieldDifference[]
  evidence: {
    manifestKey: typeof SHADOW_MANIFEST_KEY
    snapshotKey: string
    fieldDiffCount: number
  }
}

export type RestoreVerifyRequest = {
  backupKey: string
  targetUrl: () => string
  dryRun?: boolean
}

export type RestoreVerifyResult = {
  operation: 'restore-verify'
  status: MigrationStatus
  backupKey: string
  report?: RestoreReport
}

export type CutoverResult = {
  operation: 'cutover'
  status: MigrationStatus
  writes: string[]
  generation: number
}

export type RollbackResult = {
  operation: 'rollback'
  status: MigrationStatus
  writes: string[]
  generation: number
}

function fail(code: string): never {
  throw new Error(code)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function decodeJson(bytes: Uint8Array, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    fail(code)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareValue(expected: unknown, actual: unknown, path: string, differences: FieldDifference[]): void {
  if (Object.is(expected, actual)) return

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length)
    for (let index = 0; index < length; index += 1) {
      compareValue(expected[index], actual[index], `${path}/${index}`, differences)
    }
    return
  }

  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    for (const key of keys) {
      compareValue(expected[key], actual[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, differences)
    }
    return
  }

  differences.push({ path, expected, actual })
}

/** Compare a reference payload with a shadow payload using stable JSON-pointer paths. */
export function compareFields(expected: unknown, actual: unknown): FieldDifference[] {
  const differences: FieldDifference[] = []
  compareValue(expected, actual, '', differences)
  return differences.map((difference) => ({
    ...difference,
    path: difference.path || '/',
  }))
}

function physicalSnapshotKey(manifestKey: string, snapshotKey: string): string {
  if (manifestKey === SHADOW_MANIFEST_KEY) return `shadow/${snapshotKey}`
  if (manifestKey === LIVE_MANIFEST_KEY) return snapshotKey
  fail('MIGRATION_MANIFEST_KEY_INVALID')
}

function manifestBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

/**
 * Validate a manifest/snapshot pair before it can be used as a cutover or
 * rollback input. The caller must still provide the pair through an injected
 * port; this function has no production storage or control-plane default.
 */
export async function verifyManifestEnvelope(input: {
  key: typeof LIVE_MANIFEST_KEY | typeof SHADOW_MANIFEST_KEY
  bytes: Uint8Array
  snapshotBytes: Uint8Array
}): Promise<VerifiedManifest> {
  const parsedManifest = parsePublicSnapshotManifestV1(decodeJson(input.bytes, 'MIGRATION_MANIFEST_INVALID'))
  if (!sameBytes(input.bytes, manifestBytes(parsedManifest))) fail('MIGRATION_MANIFEST_INVALID')

  const snapshot = await parsePublicSnapshotV1(decodeJson(input.snapshotBytes, 'MIGRATION_SNAPSHOT_INVALID'))
  if (!sameBytes(input.snapshotBytes, canonicalSnapshotBytes(snapshot))) fail('MIGRATION_SNAPSHOT_INVALID')
  if (snapshot.generation !== parsedManifest.generation
    || snapshot.content_hash !== parsedManifest.content_sha256
    || snapshot.published_at !== Date.parse(parsedManifest.published_at) / 1_000
    || snapshot.summary._total !== parsedManifest.item_count) {
    fail('MIGRATION_MANIFEST_SNAPSHOT_MISMATCH')
  }

  return {
    key: input.key,
    bytes: input.bytes,
    snapshotBytes: input.snapshotBytes,
    manifest: parsedManifest,
    verified: true,
  }
}

export async function readVerifiedManifest(
  storage: MigrationStoragePort,
  key: typeof LIVE_MANIFEST_KEY | typeof SHADOW_MANIFEST_KEY,
): Promise<VerifiedManifest> {
  const bytes = await storage.get(key)
  if (!bytes) fail('MIGRATION_MANIFEST_MISSING')
  const parsed = parsePublicSnapshotManifestV1(decodeJson(bytes, 'MIGRATION_MANIFEST_INVALID'))
  const snapshotBytes = await storage.get(physicalSnapshotKey(key, parsed.snapshot_key))
  if (!snapshotBytes) fail('MIGRATION_SNAPSHOT_MISSING')
  return verifyManifestEnvelope({ key, bytes, snapshotBytes })
}

async function assertVerifiedManifest(value: VerifiedManifest): Promise<VerifiedManifest> {
  if (!value || value.verified !== true) fail('ROLLBACK_MANIFEST_UNVERIFIED')
  try {
    return await verifyManifestEnvelope({ key: value.key, bytes: value.bytes, snapshotBytes: value.snapshotBytes })
  } catch (error) {
    if (error instanceof Error && /^MIGRATION_[A-Z0-9_]+$/.test(error.message)) throw error
    fail('ROLLBACK_MANIFEST_UNVERIFIED')
  }
}

/** Write only shadow objects, then compare the supplied live/shadow projections. */
export async function shadowCompare(
  storage: MigrationStoragePort,
  request: ShadowCompareRequest,
): Promise<ShadowCompareResult> {
  if (!request.snapshotKey || request.snapshotKey.startsWith('shadow/') || request.snapshotKey.startsWith('public/')) {
    fail('SHADOW_SNAPSHOT_KEY_INVALID')
  }
  const verified = await verifyManifestEnvelope({
    key: SHADOW_MANIFEST_KEY,
    bytes: request.manifestBytes,
    snapshotBytes: request.snapshotBytes,
  })
  if (verified.manifest.snapshot_key !== request.snapshotKey) fail('SHADOW_SNAPSHOT_KEY_MISMATCH')

  const differences = compareFields(request.live, request.shadow)
  const writes = [`shadow/${request.snapshotKey}`, SHADOW_MANIFEST_KEY]
  if (!request.dryRun) {
    await storage.put(writes[0]!, request.snapshotBytes)
    await storage.put(writes[1]!, request.manifestBytes)
  }
  return {
    operation: 'shadow-compare',
    status: request.dryRun ? 'dry_run' : 'executed',
    namespace: 'shadow',
    writes: request.dryRun ? [] : writes,
    equal: differences.length === 0,
    differences,
    evidence: {
      manifestKey: SHADOW_MANIFEST_KEY,
      snapshotKey: request.snapshotKey,
      fieldDiffCount: differences.length,
    },
  }
}

export async function restoreVerifyOperation(
  deps: RestoreDependencies,
  request: RestoreVerifyRequest,
): Promise<RestoreVerifyResult> {
  if (typeof request.targetUrl !== 'function') fail('RESTORE_TARGET_INVALID')
  if (request.dryRun) {
    return { operation: 'restore-verify', status: 'dry_run', backupKey: request.backupKey }
  }
  return {
    operation: 'restore-verify',
    status: 'executed',
    backupKey: request.backupKey,
    report: await restoreVerify(deps, request.backupKey, request.targetUrl),
  }
}

export async function cutover(
  storage: MigrationStoragePort,
  request: { verifiedShadow: VerifiedManifest; approvalToken?: string; dryRun?: boolean },
): Promise<CutoverResult> {
  if (!request.approvalToken?.trim()) fail('CUTOVER_APPROVAL_REQUIRED')
  const verified = await assertVerifiedManifest(request.verifiedShadow)
  if (verified.key !== SHADOW_MANIFEST_KEY) fail('CUTOVER_SHADOW_MANIFEST_REQUIRED')
  if (request.dryRun) {
    return {
      operation: 'cutover',
      status: 'dry_run',
      writes: [],
      generation: verified.manifest.generation,
    }
  }
  await storage.put(LIVE_MANIFEST_KEY, verified.bytes)
  return {
    operation: 'cutover',
    status: 'executed',
    writes: [LIVE_MANIFEST_KEY],
    generation: verified.manifest.generation,
  }
}

export async function rollback(
  storage: MigrationStoragePort,
  request: { verifiedManifest: VerifiedManifest; dryRun?: boolean },
): Promise<RollbackResult> {
  const verified = await assertVerifiedManifest(request.verifiedManifest)
  if (verified.key !== LIVE_MANIFEST_KEY) fail('ROLLBACK_LIVE_MANIFEST_REQUIRED')
  if (request.dryRun) {
    return {
      operation: 'rollback',
      status: 'dry_run',
      writes: [],
      generation: verified.manifest.generation,
    }
  }
  await storage.put(LIVE_MANIFEST_KEY, verified.bytes)
  return {
    operation: 'rollback',
    status: 'executed',
    writes: [LIVE_MANIFEST_KEY],
    generation: verified.manifest.generation,
  }
}
