export const LEGACY_RESOURCE_KINDS = [
  'd1',
  'kv',
  'queue',
  'workflow',
  'durable_object',
  'r2',
] as const

export type LegacyResourceKind = typeof LEGACY_RESOURCE_KINDS[number]

export type LegacyResourceInventoryEntry = Readonly<{
  kind: LegacyResourceKind
  name: string
  identifier: string
  state: 'disabled' | 'retained'
}>

export type LegacyResourceInventory = Readonly<{
  schemaVersion: 1
  resources: readonly LegacyResourceInventoryEntry[]
}>

const inventoryResources: readonly LegacyResourceInventoryEntry[] = Object.freeze([
  { kind: 'd1', name: '<legacy-d1-binding>', identifier: '<recorded-resource-id>', state: 'retained' },
  { kind: 'kv', name: '<legacy-kv-binding>', identifier: '<recorded-resource-id>', state: 'retained' },
  { kind: 'queue', name: '<legacy-queue-binding>', identifier: '<recorded-resource-id>', state: 'retained' },
  { kind: 'workflow', name: '<legacy-workflow-binding>', identifier: '<recorded-resource-id>', state: 'retained' },
  { kind: 'durable_object', name: '<legacy-do-binding>', identifier: '<recorded-resource-id>', state: 'retained' },
  { kind: 'r2', name: '<legacy-r2-binding>', identifier: '<recorded-resource-id>', state: 'retained' },
])

/** A documentation-only inventory shape; it has no credential or mutation fields. */
export const LEGACY_RESOURCE_INVENTORY_TEMPLATE: LegacyResourceInventory = Object.freeze({
  schemaVersion: 1,
  resources: inventoryResources,
})

export type CleanupEvidenceRecord = Readonly<{
  completedAt?: string | number | Date
  verifiedAt?: string | number | Date
  approvedAt?: string | number | Date
  evidenceRef?: string
}>

export type LegacyCleanupEvidence = Readonly<{
  sevenDayObservation?: CleanupEvidenceRecord | null
  restoreEvidence?: CleanupEvidenceRecord | null
  rollbackDependencies?: readonly string[] | null
  independentOpenSpecApproval?: CleanupEvidenceRecord & Readonly<{ changeId?: string }> | null
}>

export type LegacyCleanupGateReason =
  | 'retention_period_incomplete'
  | 'seven_day_observation_missing'
  | 'restore_evidence_missing'
  | 'rollback_dependency_missing'
  | 'independent_openspec_approval_missing'

export type LegacyCleanupGateResult = Readonly<{
  status: 'approved' | 'blocked'
  reasons: readonly LegacyCleanupGateReason[]
}>

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000

function toEpochMs(value: string | number | Date): number | null {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function hasObservationEvidence(
  evidence: CleanupEvidenceRecord | null | undefined,
  cutoverMs: number | null,
  nowMs: number | null,
): boolean {
  if (!evidence?.evidenceRef?.trim() || cutoverMs === null || nowMs === null) return false
  const completedAt = evidence.completedAt === undefined ? null : toEpochMs(evidence.completedAt)
  return completedAt !== null && completedAt >= cutoverMs + SEVEN_DAYS_MS && completedAt <= nowMs
}

function hasRestoreEvidence(
  evidence: CleanupEvidenceRecord | null | undefined,
  nowMs: number | null,
): boolean {
  if (!evidence?.evidenceRef?.trim() || nowMs === null) return false
  const verifiedAt = evidence.verifiedAt === undefined ? null : toEpochMs(evidence.verifiedAt)
  return verifiedAt !== null && verifiedAt <= nowMs
}

function hasApprovalEvidence(
  evidence: (CleanupEvidenceRecord & Readonly<{ changeId?: string }>) | null | undefined,
  nowMs: number | null,
): boolean {
  if (!evidence?.changeId?.trim() || nowMs === null) return false
  const approvedAt = evidence.approvedAt === undefined ? null : toEpochMs(evidence.approvedAt)
  return approvedAt !== null && approvedAt <= nowMs
}

/**
 * Evaluate cleanup evidence without sleeping, reading Cloudflare, or deleting
 * anything. The caller supplies ISO timestamps (or epoch milliseconds).
 */
export function evaluateLegacyCleanupGate(
  cutoverAt: string | number | Date,
  now: string | number | Date,
  evidence: LegacyCleanupEvidence,
): LegacyCleanupGateResult {
  const cutoverMs = toEpochMs(cutoverAt)
  const nowMs = toEpochMs(now)
  const reasons: LegacyCleanupGateReason[] = []

  if (cutoverMs === null || nowMs === null || nowMs < cutoverMs + THIRTY_DAYS_MS) {
    reasons.push('retention_period_incomplete')
  }
  if (!hasObservationEvidence(evidence.sevenDayObservation, cutoverMs, nowMs)) {
    reasons.push('seven_day_observation_missing')
  }
  if (!hasRestoreEvidence(evidence.restoreEvidence, nowMs)) {
    reasons.push('restore_evidence_missing')
  }
  if (!evidence.rollbackDependencies?.some((dependency) => dependency.trim().length > 0)) {
    reasons.push('rollback_dependency_missing')
  }
  if (!hasApprovalEvidence(evidence.independentOpenSpecApproval, nowMs)) {
    reasons.push('independent_openspec_approval_missing')
  }

  return {
    status: reasons.length === 0 ? 'approved' : 'blocked',
    reasons,
  }
}
