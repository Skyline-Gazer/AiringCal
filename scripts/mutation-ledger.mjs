/**
 * #208 BUG-004: Point-of-execution external mutation ledger.
 *
 * Records material external mutations (bucket creation, token creation,
 * token cleanup/rotation, r2.dev disable, custom domain, zone rules,
 * GitHub Environment/vars/secrets, Worker/EdgeOne deploys, isolation probes,
 * workflow/gate changes) at the exact moment they are attempted and settled.
 *
 * No external database or daemon: lives in memory per apply run and is
 * serialized into sanitized apply receipts / inventory mutationReceipts.
 */

export const MUTATION_STATUSES = Object.freeze([
  'intended',
  'attempted',
  'confirmed-success',
  'confirmed-failed',
  'unknown-outcome',
  'already-exists',
  'compensation-success',
  'compensation-failed',
])

const EXECUTED_OR_UNCERTAIN_STATUSES = new Set([
  'confirmed-success',
  'unknown-outcome',
  'compensation-success',
  'compensation-failed',
])

const AMBIGUOUS_TRANSPORT_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|unexpected EOF|timed out|timeout|aborted|UND_ERR_/i

/**
 * True when an external call failed with an ambiguous transport error where
 * the remote provider may have executed the mutation before the response was lost.
 */
export function isAmbiguousTransportError(error) {
  if (!error || typeof error !== 'object') {
    return AMBIGUOUS_TRANSPORT_RE.test(String(error ?? ''))
  }
  const status = Number(error.status ?? error.$metadata?.httpStatusCode)
  if (status === 502 || status === 503 || status === 504) return true
  if (Number.isFinite(status) && status >= 400 && status < 500) return false
  const name = String(error.name ?? '')
  if (name === 'AbortError' || name === 'TimeoutError' || name === 'TypeError') return true
  const code = String(error.code ?? '')
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ABORT_ERR', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true
  }
  return Boolean(error.transientNetwork) || AMBIGUOUS_TRANSPORT_RE.test(String(error.message ?? ''))
}

/**
 * Create a per-run mutation ledger.
 * @param {{ redact?: (text: string) => string, now?: () => string }} [opts]
 */
export function createMutationLedger({ redact = (v) => String(v ?? ''), now = () => new Date().toISOString() } = {}) {
  /** @type {Array<object>} */
  const records = []
  let seq = 0

  function sanitizeText(value) {
    if (value === null || value === undefined) return null
    return redact(String(value)).slice(0, 500)
  }

  function appendEntry({ op, stepId, resourceType, target, status, compensation = false, detail = null, reconciliationHint = null }) {
    seq += 1
    const entry = {
      seq,
      timestamp: now(),
      op: String(op),
      stepId: String(stepId),
      resourceType: String(resourceType),
      target: sanitizeText(target),
      status,
      compensation: Boolean(compensation),
      detail: sanitizeText(detail),
      error: null,
      reconciliationHint: sanitizeText(reconciliationHint),
    }
    records.push(entry)
    return entry
  }

  function recordIntended({ op, stepId, resourceType, target, detail = null }) {
    return appendEntry({ op, stepId, resourceType, target, status: 'intended', detail })
  }

  function begin({ op, stepId, resourceType, target, compensation = false, detail = null }) {
    const entry = appendEntry({
      op,
      stepId,
      resourceType,
      target,
      status: 'attempted',
      compensation,
      detail,
    })

    return {
      entry,
      confirm(confirmDetail = null) {
        entry.status = entry.compensation ? 'compensation-success' : 'confirmed-success'
        if (confirmDetail !== null && confirmDetail !== undefined) {
          entry.detail = sanitizeText(confirmDetail)
        }
        entry.settledAt = now()
        return entry
      },
      alreadyExists(existsDetail = null) {
        entry.status = 'already-exists'
        if (existsDetail !== null && existsDetail !== undefined) {
          entry.detail = sanitizeText(existsDetail)
        }
        entry.settledAt = now()
        return entry
      },
      fail(error, failDetail = null) {
        entry.status = entry.compensation ? 'compensation-failed' : 'confirmed-failed'
        entry.error = sanitizeText(error instanceof Error ? error.message : String(error ?? 'failed'))
        if (failDetail !== null && failDetail !== undefined) {
          entry.detail = sanitizeText(failDetail)
        }
        entry.settledAt = now()
        return entry
      },
      unknown(error, reconciliationHint) {
        entry.status = 'unknown-outcome'
        entry.error = sanitizeText(error instanceof Error ? error.message : String(error ?? 'unknown outcome'))
        entry.reconciliationHint = sanitizeText(
          reconciliationHint ?? `Inspect remote ${entry.resourceType} "${entry.target}" before retrying`,
        )
        entry.settledAt = now()
        return entry
      },
      compensationFailed(error, reconciliationHint) {
        entry.status = 'compensation-failed'
        entry.error = sanitizeText(error instanceof Error ? error.message : String(error ?? 'cleanup failed'))
        entry.reconciliationHint = sanitizeText(
          reconciliationHint ?? `Manually verify cleanup of ${entry.resourceType} "${entry.target}"`,
        )
        entry.settledAt = now()
        return entry
      },
    }
  }

  function entries() {
    return records.map((entry) => ({ ...entry }))
  }

  function summarize() {
    const snapshot = entries()
    const byStatus = (status) => snapshot.filter((entry) => entry.status === status)
    const executedOps = []
    for (const entry of snapshot) {
      if (EXECUTED_OR_UNCERTAIN_STATUSES.has(entry.status) && !executedOps.includes(entry.op)) {
        executedOps.push(entry.op)
      }
    }
    return {
      confirmed: byStatus('confirmed-success'),
      alreadyExists: byStatus('already-exists'),
      failed: byStatus('confirmed-failed'),
      unknown: byStatus('unknown-outcome'),
      compensations: byStatus('compensation-success'),
      unverifiedCleanups: byStatus('compensation-failed'),
      executedOps,
    }
  }

  return {
    recordIntended,
    begin,
    entries,
    summarize,
  }
}
