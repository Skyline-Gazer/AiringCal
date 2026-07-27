import { sha256Canonical } from './canonical-json.ts'
import type {
  BudgetSubmissionStatus,
  D1DatabaseLike,
  D1ResultLike,
  SyncBudgetResource,
} from './d1-types.ts'

export interface BudgetReservationRequest<Job = unknown> {
  date: string
  resource: SyncBudgetResource
  reservationId: string
  jobs: readonly Job[]
  privilegedCount: number
  softLimit: number
  hardLimit: number
}

export interface BudgetReservationResult {
  granted: number
  consumed: number
  soft_limit: number
  hard_limit: number
  submission: BudgetSubmissionStatus
}

export interface BudgetReservationClaim {
  result: BudgetReservationResult
  created: boolean
}

export interface BudgetSubmissionTransition {
  result: BudgetReservationResult
  transitioned: boolean
}

const INSERT_BUDGET = `
  INSERT INTO sync_budget (date, resource, reserved, consumed, updated_at)
  VALUES (?, ?, 0, 0, ?)
  ON CONFLICT(date, resource) DO NOTHING
`

const INSERT_RESERVATION = `
  WITH usage AS (
    SELECT reserved + consumed AS occupied
    FROM sync_budget
    WHERE date = ? AND resource = ?
  ),
  request AS (
    SELECT ? AS requested, ? AS privileged, ? AS soft_limit, ? AS hard_limit
  ),
  calculated AS (
    SELECT
      occupied,
      soft_limit,
      hard_limit,
      MIN(privileged, MAX(0, hard_limit - occupied))
        + MIN(
          requested - privileged,
          MAX(
            0,
            soft_limit - occupied - MIN(privileged, MAX(0, hard_limit - occupied))
          )
        ) AS granted
    FROM usage, request
  )
  INSERT INTO sync_budget_reservations (
    reservation_id,
    date,
    resource,
    request_fingerprint,
    result_json,
    submission_status,
    created_at,
    updated_at
  )
  SELECT
    ?,
    ?,
    ?,
    ?,
    json_object(
      'granted', granted,
      'consumed', occupied + granted,
      'soft_limit', soft_limit,
      'hard_limit', hard_limit
    ),
    'reserved',
    ?,
    ?
  FROM calculated
  WHERE true
  ON CONFLICT(reservation_id) DO NOTHING
`

const APPLY_RESERVATION = `
  UPDATE sync_budget
  SET
    reserved = reserved + COALESCE((
      SELECT json_extract(result_json, '$.granted')
      FROM sync_budget_reservations
      WHERE reservation_id = ?
    ), 0),
    updated_at = ?
  WHERE date = ? AND resource = ? AND changes() = 1
`

const SELECT_RESERVATION = `
  SELECT
    reservation_id,
    request_fingerprint,
    result_json,
    submission_status
  FROM sync_budget_reservations
  WHERE reservation_id = ?
`

const MOVE_RESERVED_TO_CONSUMED = `
  UPDATE sync_budget
  SET
    reserved = reserved - COALESCE((
      SELECT json_extract(result_json, '$.granted')
      FROM sync_budget_reservations
      WHERE reservation_id = ? AND submission_status = 'reserved'
    ), 0),
    consumed = consumed + COALESCE((
      SELECT json_extract(result_json, '$.granted')
      FROM sync_budget_reservations
      WHERE reservation_id = ? AND submission_status = 'reserved'
    ), 0),
    updated_at = ?
  WHERE (date, resource) = (
    SELECT date, resource
    FROM sync_budget_reservations
    WHERE reservation_id = ? AND submission_status = 'reserved'
  )
`

const UPDATE_SUBMISSION = `
  UPDATE sync_budget_reservations
  SET submission_status = ?, updated_at = ?
  WHERE reservation_id = ?
    AND (
      submission_status = 'reserved'
      OR (submission_status = 'uncertain' AND ? = 'submitted')
    )
`

interface ReservationRecord {
  reservation_id: unknown
  request_fingerprint: unknown
  result_json: unknown
  submission_status: unknown
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validateRequest(request: BudgetReservationRequest): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date)) throw new Error('Invalid budget date')
  if (request.resource !== 'media') throw new Error('Invalid budget resource')
  if (!request.reservationId) throw new Error('Invalid reservation ID')
  if (!Array.isArray(request.jobs)) throw new Error('Invalid reservation jobs')
  if (!nonNegativeInteger(request.privilegedCount) || request.privilegedCount > request.jobs.length) {
    throw new Error('Invalid privileged job count')
  }
  if (
    !nonNegativeInteger(request.softLimit)
    || !nonNegativeInteger(request.hardLimit)
    || request.softLimit > request.hardLimit
  ) {
    throw new Error('Invalid budget limits')
  }
}

function validateBatch(
  results: D1ResultLike<Record<string, unknown>>[],
  expectedCardinality: number,
): void {
  if (results.length !== expectedCardinality) throw new Error('D1 budget result cardinality mismatch')
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (
      !result
      || result.success !== true
      || !result.meta
      || !nonNegativeInteger(result.meta.changes)
      || !nonNegativeInteger(result.meta.rows_read)
      || !nonNegativeInteger(result.meta.rows_written)
      || !Array.isArray(result.results)
    ) {
      throw new Error(`Invalid D1 budget result metadata at index ${index}`)
    }
  }
}

function parseReservation(
  raw: Record<string, unknown> | undefined,
  reservationId: string,
  expectedFingerprint?: string,
): BudgetReservationResult {
  if (!raw) throw new Error(`Missing budget reservation result: ${reservationId}`)
  const row = raw as unknown as ReservationRecord
  if (row.reservation_id !== reservationId || typeof row.request_fingerprint !== 'string') {
    throw new Error('Invalid budget reservation row')
  }
  if (expectedFingerprint !== undefined && row.request_fingerprint !== expectedFingerprint) {
    throw new Error(`budget reservation payload mismatch: ${reservationId}`)
  }
  if (
    row.submission_status !== 'reserved'
    && row.submission_status !== 'submitted'
    && row.submission_status !== 'uncertain'
  ) {
    throw new Error('Invalid budget reservation submission status')
  }
  if (typeof row.result_json !== 'string') throw new Error('Invalid budget reservation result JSON')

  let parsed: unknown
  try {
    parsed = JSON.parse(row.result_json)
  } catch {
    throw new Error('Invalid budget reservation result JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid budget reservation result JSON')
  }
  const result = parsed as Record<string, unknown>
  if (
    !nonNegativeInteger(result.granted)
    || !nonNegativeInteger(result.consumed)
    || !nonNegativeInteger(result.soft_limit)
    || !nonNegativeInteger(result.hard_limit)
    || result.soft_limit > result.hard_limit
    || result.granted > result.consumed
    || result.consumed > result.hard_limit
  ) {
    throw new Error('Invalid budget reservation result JSON')
  }
  return {
    granted: result.granted,
    consumed: result.consumed,
    soft_limit: result.soft_limit,
    hard_limit: result.hard_limit,
    submission: row.submission_status,
  }
}

async function requestFingerprint(request: BudgetReservationRequest): Promise<string> {
  return sha256Canonical({
    date: request.date,
    hard_limit: request.hardLimit,
    jobs: request.jobs,
    privileged_count: request.privilegedCount,
    resource: request.resource,
    soft_limit: request.softLimit,
  })
}

export async function claimDailyBudgetReservation(
  database: D1DatabaseLike,
  request: BudgetReservationRequest,
  now = Math.floor(Date.now() / 1000),
): Promise<BudgetReservationClaim> {
  validateRequest(request)
  const fingerprint = await requestFingerprint(request)
  const requested = request.jobs.length
  const statements = [
    database.prepare(INSERT_BUDGET).bind(request.date, request.resource, now),
    database.prepare(INSERT_RESERVATION).bind(
      request.date,
      request.resource,
      requested,
      request.privilegedCount,
      request.softLimit,
      request.hardLimit,
      request.reservationId,
      request.date,
      request.resource,
      fingerprint,
      now,
      now,
    ),
    database.prepare(APPLY_RESERVATION).bind(
      request.reservationId,
      now,
      request.date,
      request.resource,
    ),
    database.prepare(SELECT_RESERVATION).bind(request.reservationId),
  ]
  const results = await database.batch(statements)
  validateBatch(results, statements.length)
  if (results[3]!.results.length !== 1) throw new Error('D1 budget result cardinality mismatch')
  return {
    result: parseReservation(results[3]!.results[0], request.reservationId, fingerprint),
    created: results[1]!.meta.changes === 1,
  }
}

export async function reserveDailyBudget(
  database: D1DatabaseLike,
  request: BudgetReservationRequest,
  now?: number,
): Promise<BudgetReservationResult> {
  return (await claimDailyBudgetReservation(database, request, now)).result
}

export async function transitionBudgetSubmission(
  database: D1DatabaseLike,
  reservationId: string,
  submission: Exclude<BudgetSubmissionStatus, 'reserved'>,
  now = Math.floor(Date.now() / 1000),
): Promise<BudgetSubmissionTransition> {
  if (!reservationId) throw new Error('Invalid reservation ID')
  const statements = [
    database.prepare(MOVE_RESERVED_TO_CONSUMED).bind(
      reservationId,
      reservationId,
      now,
      reservationId,
    ),
    database.prepare(UPDATE_SUBMISSION).bind(submission, now, reservationId, submission),
    database.prepare(SELECT_RESERVATION).bind(reservationId),
  ]
  const results = await database.batch(statements)
  validateBatch(results, statements.length)
  if (results[2]!.results.length !== 1) throw new Error('D1 budget result cardinality mismatch')
  return {
    result: parseReservation(results[2]!.results[0], reservationId),
    transitioned: results[1]!.meta.changes === 1,
  }
}

export async function markBudgetSubmission(
  database: D1DatabaseLike,
  reservationId: string,
  submission: Exclude<BudgetSubmissionStatus, 'reserved'>,
  now?: number,
): Promise<BudgetReservationResult> {
  return (await transitionBudgetSubmission(database, reservationId, submission, now)).result
}
