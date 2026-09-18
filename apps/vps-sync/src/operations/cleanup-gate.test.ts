import assert from 'node:assert/strict'
import test from 'node:test'

type CleanupGateApi = typeof import('./cleanup-gate.js')

async function cleanupGateApi(): Promise<CleanupGateApi> {
  try {
    return await import('./cleanup-gate.js')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('legacy cleanup gate is not implemented')
    }
    throw error
  }
}

const cutoverAt = '2026-01-01T00:00:00.000Z'
const afterThirtyDays = '2026-01-31T00:00:00.000Z'
const completeEvidence = {
  sevenDayObservation: {
    completedAt: '2026-01-08T00:00:00.000Z',
    evidenceRef: 'ops/observation-2026-01-08',
  },
  restoreEvidence: {
    verifiedAt: '2026-01-09T00:00:00.000Z',
    evidenceRef: 'ops/restore-2026-01-09',
  },
  rollbackDependencies: ['ghcr-image-sha', 'previous-manifest'],
  independentOpenSpecApproval: {
    changeId: 'cleanup-legacy-resources',
    approvedAt: '2026-01-30T00:00:00.000Z',
  },
}

test('blocks cleanup before the thirty-day retention period', async () => {
  const { evaluateLegacyCleanupGate } = await cleanupGateApi()
  const result = evaluateLegacyCleanupGate(cutoverAt, '2026-01-30T23:59:59.000Z', completeEvidence)

  assert.equal(result.status, 'blocked')
  assert.ok(result.reasons.includes('retention_period_incomplete'))
})

test('blocks cleanup when seven-day observation evidence is missing', async () => {
  const { evaluateLegacyCleanupGate } = await cleanupGateApi()
  const result = evaluateLegacyCleanupGate(cutoverAt, afterThirtyDays, {
    ...completeEvidence,
    sevenDayObservation: null,
  })

  assert.equal(result.status, 'blocked')
  assert.ok(result.reasons.includes('seven_day_observation_missing'))
})

test('blocks cleanup when restore evidence is missing', async () => {
  const { evaluateLegacyCleanupGate } = await cleanupGateApi()
  const result = evaluateLegacyCleanupGate(cutoverAt, afterThirtyDays, {
    ...completeEvidence,
    restoreEvidence: null,
  })

  assert.equal(result.status, 'blocked')
  assert.ok(result.reasons.includes('restore_evidence_missing'))
})

test('blocks cleanup when rollback dependencies are not recorded', async () => {
  const { evaluateLegacyCleanupGate } = await cleanupGateApi()
  const result = evaluateLegacyCleanupGate(cutoverAt, afterThirtyDays, {
    ...completeEvidence,
    rollbackDependencies: [],
  })

  assert.equal(result.status, 'blocked')
  assert.ok(result.reasons.includes('rollback_dependency_missing'))
})

test('blocks cleanup without an independent OpenSpec approval', async () => {
  const { evaluateLegacyCleanupGate } = await cleanupGateApi()
  const result = evaluateLegacyCleanupGate(cutoverAt, afterThirtyDays, {
    ...completeEvidence,
    independentOpenSpecApproval: null,
  })

  assert.equal(result.status, 'blocked')
  assert.ok(result.reasons.includes('independent_openspec_approval_missing'))
})

test('approves cleanup only after every retention and evidence gate passes', async () => {
  const { evaluateLegacyCleanupGate } = await cleanupGateApi()
  const result = evaluateLegacyCleanupGate(cutoverAt, afterThirtyDays, completeEvidence)

  assert.deepEqual(result, { status: 'approved', reasons: [] })
})

test('fails closed without throwing for malformed caller input', async () => {
  const { evaluateLegacyCleanupGate } = await cleanupGateApi()
  const evaluate = (cutover: unknown, now: unknown, evidence: unknown) =>
    evaluateLegacyCleanupGate(cutover as never, now as never, evidence as never)
  const malformedInputs: Array<[unknown, unknown, unknown]> = [
    [null, afterThirtyDays, completeEvidence],
    [cutoverAt, {}, completeEvidence],
    [cutoverAt, afterThirtyDays, null],
    [cutoverAt, afterThirtyDays, 'evidence'],
    [cutoverAt, afterThirtyDays, { ...completeEvidence, sevenDayObservation: 'evidence' }],
    [cutoverAt, afterThirtyDays, { ...completeEvidence, restoreEvidence: 42 }],
    [cutoverAt, afterThirtyDays, { ...completeEvidence, rollbackDependencies: ['valid', 42] }],
    [cutoverAt, afterThirtyDays, { ...completeEvidence, independentOpenSpecApproval: 'approval' }],
    [Symbol('cutover'), afterThirtyDays, completeEvidence],
  ]

  for (const [cutover, now, evidence] of malformedInputs) {
    assert.doesNotThrow(() => {
      assert.equal(evaluate(cutover, now, evidence).status, 'blocked')
    })
  }
})

test('resource inventory template is read-only and covers every legacy resource kind', async () => {
  const { LEGACY_RESOURCE_KINDS, LEGACY_RESOURCE_INVENTORY_TEMPLATE } = await cleanupGateApi()

  assert.deepEqual(LEGACY_RESOURCE_KINDS, ['d1', 'kv', 'queue', 'workflow', 'durable_object', 'r2'])
  assert.deepEqual(
    LEGACY_RESOURCE_INVENTORY_TEMPLATE.resources.map(({ kind }) => kind),
    LEGACY_RESOURCE_KINDS,
  )
  assert.doesNotMatch(JSON.stringify(LEGACY_RESOURCE_INVENTORY_TEMPLATE), /credential|password|secret|token|access.?key/i)
})
