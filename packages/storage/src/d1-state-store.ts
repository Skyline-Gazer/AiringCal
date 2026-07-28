import { canonicalJson } from './canonical-json.ts'
import {
  claimDailyBudgetReservation,
  markBudgetSubmission,
  reserveDailyBudget,
  type BudgetReservationRequest,
} from './d1-budget.ts'
import type {
  CollectionDiffPlanLike,
  CollectionRow,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  SyncRunCompletion,
  SyncRunFailure,
  SyncRunRow,
  SyncTerminalTransitionResult,
  SyncRunUpdate,
  SubjectMediaRow,
} from './d1-types.ts'

const COLLECTION_COLUMNS = [
  'user_id',
  'subject_id',
  'collection_type',
  'rate',
  'tags_json',
  'comment',
  'ep_status',
  'vol_status',
  'upstream_updated_at',
  'subject_json',
  'content_hash',
  'state_version',
  'temperature',
  'first_seen_at',
  'changed_at',
  'missing_since',
  'deleted_at',
] as const

const COLLECTION_SELECT = `SELECT ${COLLECTION_COLUMNS.join(', ')} FROM collection_items ORDER BY user_id, subject_id`
const COLLECTION_SELECT_ONE = `SELECT ${COLLECTION_COLUMNS.join(', ')} FROM collection_items WHERE user_id = ? AND subject_id = ?`
const SUBJECT_MEDIA_COLUMNS = [
  'subject_id',
  'detail_json',
  'detail_hash',
  'media_hash',
  'nsfw',
  'source_image_common_url',
  'source_image_large_url',
  'r2_image_common_key',
  'r2_image_large_key',
  'checked_at',
  'next_refresh_at',
  'retry_count',
  'retry_after',
  'error_code',
] as const
const SUBJECT_MEDIA_SELECT = `SELECT ${SUBJECT_MEDIA_COLUMNS.join(', ')} FROM subject_media ORDER BY subject_id`
const COLLECTION_INSERT = `INSERT INTO collection_items (${COLLECTION_COLUMNS.join(', ')}) VALUES (${COLLECTION_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(user_id, subject_id) DO UPDATE SET collection_type = excluded.collection_type, rate = excluded.rate, tags_json = excluded.tags_json, comment = excluded.comment, ep_status = excluded.ep_status, vol_status = excluded.vol_status, upstream_updated_at = excluded.upstream_updated_at, subject_json = excluded.subject_json, content_hash = excluded.content_hash, state_version = collection_items.state_version, temperature = excluded.temperature, first_seen_at = MIN(collection_items.first_seen_at, excluded.first_seen_at), changed_at = excluded.changed_at, missing_since = excluded.missing_since, deleted_at = excluded.deleted_at WHERE collection_items.state_version = 1 AND collection_items.missing_since IS NULL AND collection_items.deleted_at IS NULL AND (excluded.changed_at > collection_items.changed_at OR (excluded.changed_at = collection_items.changed_at AND excluded.content_hash > collection_items.content_hash COLLATE BINARY))`
const COLLECTION_UPDATE_FIELDS = COLLECTION_COLUMNS.slice(2).map((column) => `${column} = ?`).join(', ')
const COLLECTION_UPDATE = `UPDATE collection_items SET ${COLLECTION_UPDATE_FIELDS} WHERE user_id = ? AND subject_id = ? AND state_version = ?`
const COLLECTION_RESTORE = `UPDATE collection_items SET ${COLLECTION_UPDATE_FIELDS} WHERE user_id = ? AND subject_id = ? AND state_version = ?`
const FIRST_MISSING_UPDATE = 'UPDATE collection_items SET missing_since = ?, state_version = ? WHERE user_id = ? AND subject_id = ? AND state_version = ?'
const CONFIRMED_DELETED_UPDATE = 'UPDATE collection_items SET deleted_at = ?, state_version = ? WHERE user_id = ? AND subject_id = ? AND state_version = ?'
const MAX_BATCH_STATEMENTS = 50
const CLASSIFIED_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const SYNC_RUN_COLUMNS = [
  'instance_id', 'status', 'stage', 'generation', 'collection_count', 'changed_count',
  'missing_count', 'deleted_count', 'media_selected_count', 'media_granted_count',
  'input_hash', 'public_hash', 'result_json', 'error_code', 'started_at', 'heartbeat_at', 'completed_at',
] as const

export class StaleCollectionDiffError extends Error {
  readonly code = 'STALE_COLLECTION_DIFF'

  constructor(
    readonly userId: string,
    readonly subjectId: number,
  ) {
    super(`Stale collection diff conflict: ${userId}:${subjectId}`)
    this.name = 'StaleCollectionDiffError'
  }
}

interface PendingWrite {
  userId: string
  subjectId: number
  order: number
  kind: 'insert' | 'mutation'
  planned: CollectionRow
  statement: D1PreparedStatementLike
}

function collectionValues(row: CollectionRow): unknown[] {
  return COLLECTION_COLUMNS.map((column) => row[column])
}

function collectionUpdateValues(row: CollectionRow): unknown[] {
  return COLLECTION_COLUMNS.slice(2).map((column) => row[column])
}

function compareWrites(left: PendingWrite, right: PendingWrite): number {
  if (left.userId < right.userId) return -1
  if (left.userId > right.userId) return 1
  return left.subjectId - right.subjectId || left.order - right.order
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid collection_items.${column}`)
  return value
}

function nullableString(value: unknown, column: string): string | null {
  if (value === null) return null
  return requireString(value, column)
}

function requireInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid collection_items.${column}`)
  }
  return value
}

function requirePositiveInteger(value: unknown, column: string): number {
  const integer = requireInteger(value, column)
  if (integer < 1) throw new Error(`Invalid collection_items.${column}`)
  return integer
}

function nullableInteger(value: unknown, column: string): number | null {
  if (value === null) return null
  return requireInteger(value, column)
}

function validateJson(value: string, column: string, requireArray = false): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`Invalid collection_items.${column}`)
  }
  if (requireArray && !Array.isArray(parsed)) throw new Error(`Invalid collection_items.${column}`)
  if (!requireArray && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    throw new Error(`Invalid collection_items.${column}`)
  }
  return value
}

function decodeCollectionRow(raw: Record<string, unknown>): CollectionRow {
  const temperature = requireString(raw.temperature, 'temperature')
  if (temperature !== 'hot' && temperature !== 'cold') {
    throw new Error('Invalid collection_items.temperature')
  }
  return {
    user_id: requireString(raw.user_id, 'user_id'),
    subject_id: requireInteger(raw.subject_id, 'subject_id'),
    collection_type: requireInteger(raw.collection_type, 'collection_type'),
    rate: nullableInteger(raw.rate, 'rate'),
    tags_json: validateJson(requireString(raw.tags_json, 'tags_json'), 'tags_json', true),
    comment: requireString(raw.comment, 'comment'),
    ep_status: requireInteger(raw.ep_status, 'ep_status'),
    vol_status: requireInteger(raw.vol_status, 'vol_status'),
    upstream_updated_at: nullableString(raw.upstream_updated_at, 'upstream_updated_at'),
    subject_json: validateJson(requireString(raw.subject_json, 'subject_json'), 'subject_json'),
    content_hash: requireString(raw.content_hash, 'content_hash'),
    state_version: requirePositiveInteger(raw.state_version, 'state_version'),
    temperature,
    first_seen_at: requireInteger(raw.first_seen_at, 'first_seen_at'),
    changed_at: requireInteger(raw.changed_at, 'changed_at'),
    missing_since: nullableInteger(raw.missing_since, 'missing_since'),
    deleted_at: nullableInteger(raw.deleted_at, 'deleted_at'),
  }
}

function decodeSubjectMediaRow(raw: Record<string, unknown>): SubjectMediaRow {
  const nsfw = requireInteger(raw.nsfw, 'nsfw')
  if (nsfw !== 0 && nsfw !== 1) throw new Error('Invalid subject_media.nsfw')
  const detailJson = nullableString(raw.detail_json, 'detail_json')
  if (detailJson !== null) validateJson(detailJson, 'detail_json')
  const retryCount = requireInteger(raw.retry_count, 'retry_count')
  if (retryCount < 0) throw new Error('Invalid subject_media.retry_count')
  return {
    subject_id: requirePositiveInteger(raw.subject_id, 'subject_id'),
    detail_json: detailJson,
    detail_hash: nullableString(raw.detail_hash, 'detail_hash'),
    media_hash: nullableString(raw.media_hash, 'media_hash'),
    nsfw,
    source_image_common_url: nullableString(raw.source_image_common_url, 'source_image_common_url'),
    source_image_large_url: nullableString(raw.source_image_large_url, 'source_image_large_url'),
    r2_image_common_key: nullableString(raw.r2_image_common_key, 'r2_image_common_key'),
    r2_image_large_key: nullableString(raw.r2_image_large_key, 'r2_image_large_key'),
    checked_at: nullableInteger(raw.checked_at, 'checked_at'),
    next_refresh_at: nullableInteger(raw.next_refresh_at, 'next_refresh_at'),
    retry_count: retryCount,
    retry_after: nullableInteger(raw.retry_after, 'retry_after'),
    error_code: nullableString(raw.error_code, 'error_code'),
  }
}

function priorStateVersion(row: CollectionRow): number {
  if (!Number.isSafeInteger(row.state_version) || row.state_version <= 1) {
    throw new Error('Invalid planned collection state_version')
  }
  return row.state_version - 1
}

function assertClassifiedErrorCode(errorCode: string | null): void {
  if (errorCode !== null && !CLASSIFIED_ERROR_CODE.test(errorCode)) {
    throw new Error('sync_runs.error_code must be a classified error code')
  }
}

function decodeSyncRunRow(raw: Record<string, unknown>): SyncRunRow {
  const requireSyncString = (value: unknown, column: string): string => {
    if (typeof value !== 'string') throw new Error(`Invalid sync_runs.${column}`)
    return value
  }
  const nullableSyncString = (value: unknown, column: string): string | null => {
    if (value === null) return null
    return requireSyncString(value, column)
  }
  const requireSyncCount = (value: unknown, column: string): number => {
    if (!isNonNegativeInteger(value)) throw new Error(`Invalid sync_runs.${column}`)
    return value
  }
  const nullableSyncInteger = (value: unknown, column: string): number | null => {
    if (value === null) return null
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid sync_runs.${column}`)
    }
    return value
  }
  const resultJson = nullableSyncString(raw.result_json, 'result_json')
  if (resultJson !== null) {
    try {
      JSON.parse(resultJson)
    } catch {
      throw new Error('Invalid sync_runs.result_json')
    }
  }
  const errorCode = nullableSyncString(raw.error_code, 'error_code')
  assertClassifiedErrorCode(errorCode)
  return {
    instance_id: requireSyncString(raw.instance_id, 'instance_id'),
    status: requireSyncString(raw.status, 'status'),
    stage: requireSyncString(raw.stage, 'stage'),
    generation: nullableSyncInteger(raw.generation, 'generation'),
    collection_count: requireSyncCount(raw.collection_count, 'collection_count'),
    changed_count: requireSyncCount(raw.changed_count, 'changed_count'),
    missing_count: requireSyncCount(raw.missing_count, 'missing_count'),
    deleted_count: requireSyncCount(raw.deleted_count, 'deleted_count'),
    media_selected_count: requireSyncCount(raw.media_selected_count, 'media_selected_count'),
    media_granted_count: requireSyncCount(raw.media_granted_count, 'media_granted_count'),
    input_hash: nullableSyncString(raw.input_hash, 'input_hash'),
    public_hash: nullableSyncString(raw.public_hash, 'public_hash'),
    result_json: resultJson,
    error_code: errorCode,
    started_at: requireSyncCount(raw.started_at, 'started_at'),
    heartbeat_at: requireSyncCount(raw.heartbeat_at, 'heartbeat_at'),
    completed_at: nullableSyncInteger(raw.completed_at, 'completed_at'),
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function appliedChanges(result: D1ResultLike<unknown>, index: number): number {
  if (
    result === null
    || typeof result !== 'object'
    || result.success !== true
    || result.meta === null
    || typeof result.meta !== 'object'
    || !isNonNegativeInteger(result.meta.changes)
    || !isNonNegativeInteger(result.meta.rows_written)
  ) {
    throw new Error(`Invalid D1 batch result at index ${index}`)
  }
  return result.meta.changes
}

export class D1StateStore {
  constructor(
    private readonly database: D1DatabaseLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  reserveDailyBudget(request: BudgetReservationRequest) {
    return reserveDailyBudget(this.database, request, this.now())
  }

  claimDailyBudgetReservation(request: BudgetReservationRequest) {
    return claimDailyBudgetReservation(this.database, request, this.now())
  }

  markBudgetSubmission(
    reservationId: string,
    submission: 'submitted' | 'uncertain',
  ) {
    return markBudgetSubmission(this.database, reservationId, submission, this.now())
  }

  private async executeBatch(statements: D1PreparedStatementLike[]): Promise<number> {
    return (await this.executeBatchChanges(statements)).reduce((total, changes) => total + changes, 0)
  }

  private async executeBatchChanges(statements: D1PreparedStatementLike[]): Promise<number[]> {
    const results = await this.database.batch(statements)
    if (results.length !== statements.length) throw new Error('D1 batch result cardinality mismatch')
    return results.map((result, index) => appliedChanges(result, index))
  }

  private async collectionRow(userId: string, subjectId: number): Promise<CollectionRow | undefined> {
    const raw = await this.database.prepare(COLLECTION_SELECT_ONE).bind(userId, subjectId).first<Record<string, unknown>>()
    return raw === null ? undefined : decodeCollectionRow(raw)
  }

  private async reconcileCollectionNoChange(write: PendingWrite): Promise<void> {
    const current = await this.collectionRow(write.userId, write.subjectId)
    const exact = current && COLLECTION_COLUMNS.every((column) => current[column] === write.planned[column])
    if (exact) return
    if (
      write.kind === 'insert'
      && current
      && current.state_version === 1
      && current.missing_since === null
      && current.deleted_at === null
      && current.first_seen_at <= write.planned.first_seen_at
      && COLLECTION_COLUMNS.every((column) =>
        column === 'first_seen_at' || current[column] === write.planned[column])
    ) return
    throw new StaleCollectionDiffError(write.userId, write.subjectId)
  }

  private syncRunUpdateStatement(instanceId: string, update: SyncRunUpdate): D1PreparedStatementLike {
    const optionalColumns = [
      'generation', 'collection_count', 'changed_count', 'missing_count', 'deleted_count',
      'media_selected_count', 'media_granted_count', 'input_hash', 'public_hash', 'result_json',
    ] as const
    const present = optionalColumns.filter((column) => update[column] !== undefined)
    const columns = ['stage', 'heartbeat_at', ...present] as const
    return this.database.prepare(
      `UPDATE sync_runs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE instance_id = ? AND status NOT IN ('ok', 'error')`,
    ).bind(...columns.map((column) => update[column]), instanceId)
  }

  private async assertSyncRunUpdateApplied(instanceId: string, changes: number): Promise<void> {
    if (changes !== 0) return
    const status = await this.getSyncRunStatus(instanceId)
    if (status === undefined) throw new Error(`Sync run not found: ${instanceId}`)
    if (status === 'ok' || status === 'error') throw new Error(`Sync run already terminal: ${status}`)
    throw new Error(`Sync run update not applied: ${instanceId}`)
  }

  async getSyncRunStatus(instanceId: string): Promise<string | undefined> {
    const row = await this.database
      .prepare('SELECT status FROM sync_runs WHERE instance_id = ?')
      .bind(instanceId)
      .first<{ status: unknown }>()
    if (row === null) return undefined
    if (typeof row.status !== 'string') throw new Error(`Invalid sync run status: ${instanceId}`)
    return row.status
  }

  async getSyncRun(instanceId: string): Promise<SyncRunRow | undefined> {
    const row = await this.database
      .prepare(`SELECT ${SYNC_RUN_COLUMNS.join(', ')} FROM sync_runs WHERE instance_id = ?`)
      .bind(instanceId)
      .first<Record<string, unknown>>()
    return row === null ? undefined : decodeSyncRunRow(row)
  }

  async listCollectionRows(): Promise<CollectionRow[]> {
    const result = await this.database.prepare(COLLECTION_SELECT).all<Record<string, unknown>>()
    return result.results.map(decodeCollectionRow)
  }

  async listSubjectMediaRows(): Promise<SubjectMediaRow[]> {
    const result = await this.database.prepare(SUBJECT_MEDIA_SELECT).all<Record<string, unknown>>()
    return result.results.map(decodeSubjectMediaRow)
  }

  async applyCollectionDiff(
    plan: CollectionDiffPlanLike,
    checkpoint?: { instanceId: string; update: SyncRunUpdate },
  ): Promise<{ rowsWritten: number }> {
    const writes: PendingWrite[] = []
    const addBusinessUpdate = (row: CollectionRow, order: number) => {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order,
        kind: 'mutation',
        planned: row,
        statement: this.database.prepare(COLLECTION_UPDATE).bind(
          ...collectionUpdateValues(row),
          row.user_id,
          row.subject_id,
          priorStateVersion(row),
        ),
      })
    }
    const addRestore = (row: CollectionRow, order: number) => {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order,
        kind: 'mutation',
        planned: row,
        statement: this.database.prepare(COLLECTION_RESTORE).bind(
          ...collectionUpdateValues(row),
          row.user_id,
          row.subject_id,
          priorStateVersion(row),
        ),
      })
    }

    for (const row of plan.inserts) {
      if (row.state_version !== 1) throw new Error('Invalid collection insert state_version')
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order: 4,
        kind: 'insert',
        planned: row,
        statement: this.database.prepare(COLLECTION_INSERT).bind(...collectionValues(row)),
      })
    }
    for (const row of plan.updates) addBusinessUpdate(row, 3)
    for (const row of plan.firstMissing) {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order: 2,
        kind: 'mutation',
        planned: row,
        statement: this.database.prepare(FIRST_MISSING_UPDATE).bind(
          row.missing_since,
          row.state_version,
          row.user_id,
          row.subject_id,
          priorStateVersion(row),
        ),
      })
    }
    for (const row of plan.confirmedDeleted) {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order: 1,
        kind: 'mutation',
        planned: row,
        statement: this.database.prepare(CONFIRMED_DELETED_UPDATE).bind(
          row.deleted_at,
          row.state_version,
          row.user_id,
          row.subject_id,
          priorStateVersion(row),
        ),
      })
    }
    for (const row of plan.restored) addRestore(row, 0)

    writes.sort(compareWrites)
    let rowsWritten = 0
    const mutationBatchSize = checkpoint ? MAX_BATCH_STATEMENTS - 1 : MAX_BATCH_STATEMENTS
    if (writes.length === 0 && checkpoint) {
      const [checkpointChanges] = await this.executeBatchChanges([
        this.syncRunUpdateStatement(checkpoint.instanceId, checkpoint.update),
      ])
      await this.assertSyncRunUpdateApplied(checkpoint.instanceId, checkpointChanges!)
    }
    for (let offset = 0; offset < writes.length; offset += mutationBatchSize) {
      const chunk = writes.slice(offset, offset + mutationBatchSize)
      const statements = chunk.map(({ statement }) => statement)
      if (checkpoint) {
        statements.push(this.syncRunUpdateStatement(checkpoint.instanceId, checkpoint.update))
      }
      const changes = await this.executeBatchChanges(statements)
      const mutationChanges = changes.slice(0, chunk.length)
      rowsWritten += mutationChanges.reduce((total, count) => total + count, 0)
      if (checkpoint) {
        await this.assertSyncRunUpdateApplied(checkpoint.instanceId, changes.at(-1)!)
      }
      for (let index = 0; index < chunk.length; index++) {
        if (mutationChanges[index] === 0) await this.reconcileCollectionNoChange(chunk[index]!)
      }
    }
    return { rowsWritten }
  }

  async getAppStateUnknown(key: string): Promise<unknown | undefined> {
    const row = await this.database
      .prepare('SELECT value_json FROM app_state WHERE key = ?')
      .bind(key)
      .first<{ value_json: unknown }>()
    if (row === null) return undefined
    if (typeof row.value_json !== 'string') throw new Error('Invalid app_state JSON')

    let parsed: unknown
    try {
      parsed = JSON.parse(row.value_json)
    } catch {
      throw new Error('Invalid app_state JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Invalid app_state JSON')
    }
    const envelope = parsed as Record<string, unknown>
    if (envelope.schema_version !== 1) throw new Error('Unsupported app_state schema_version')
    if (!Object.hasOwn(envelope, 'value')) throw new Error('Invalid app_state JSON')
    return envelope.value
  }

  async getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined> {
    const value = await this.getAppStateUnknown(key)
    return value === undefined ? undefined : decode(value)
  }

  async putAppState<T>(key: string, value: T): Promise<void> {
    const valueJson = canonicalJson({ schema_version: 1, value })
    const statement = this.database.prepare(
      'INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    ).bind(key, valueJson, this.now())
    await this.executeBatch([statement])
  }

  async startSyncRun(row: SyncRunRow): Promise<void> {
    assertClassifiedErrorCode(row.error_code)
    const statement = this.database.prepare(
      `INSERT INTO sync_runs (${SYNC_RUN_COLUMNS.join(', ')}) VALUES (${SYNC_RUN_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(instance_id) DO NOTHING`,
    ).bind(...SYNC_RUN_COLUMNS.map((column) => row[column]))
    const changes = await this.executeBatch([statement])
    if (changes === 0) {
      const current = await this.getSyncRun(row.instance_id)
      if (current === undefined) throw new Error(`Sync run not found after start: ${row.instance_id}`)
      if (!SYNC_RUN_COLUMNS.every((column) => current[column] === row[column])) {
        throw new Error(`Sync run instance payload mismatch: ${row.instance_id}`)
      }
    }
  }

  async updateSyncRun(instanceId: string, update: SyncRunUpdate): Promise<void> {
    const changes = await this.executeBatch([this.syncRunUpdateStatement(instanceId, update)])
    await this.assertSyncRunUpdateApplied(instanceId, changes)
  }

  async completeSyncRun(instanceId: string, completion: SyncRunCompletion): Promise<SyncTerminalTransitionResult> {
    const statement = this.database.prepare(
      "UPDATE sync_runs SET status = 'ok', stage = 'complete', heartbeat_at = ?, completed_at = ?, generation = COALESCE(?, generation), input_hash = COALESCE(?, input_hash), public_hash = COALESCE(?, public_hash), result_json = COALESCE(?, result_json), error_code = NULL WHERE instance_id = ? AND status NOT IN ('ok', 'error')",
    ).bind(
      completion.heartbeat_at,
      completion.completed_at,
      completion.generation ?? null,
      completion.input_hash ?? null,
      completion.public_hash ?? null,
      completion.result_json ?? null,
      instanceId,
    )
    const changes = await this.executeBatch([statement])
    if (changes === 0) {
      const status = await this.getSyncRunStatus(instanceId)
      if (status === undefined) throw new Error(`Sync run not found: ${instanceId}`)
      if (status === 'ok') return { outcome: 'already_same_terminal', terminal: 'ok' }
      if (status === 'error') return { outcome: 'preserved_opposite_terminal', terminal: 'error' }
      throw new Error(`Sync run completion not applied: ${instanceId}`)
    }
    return { outcome: 'applied', terminal: 'ok' }
  }

  async failSyncRun(instanceId: string, failure: SyncRunFailure): Promise<SyncTerminalTransitionResult> {
    assertClassifiedErrorCode(failure.error_code)
    const statement = this.database.prepare(
      "UPDATE sync_runs SET status = 'error', heartbeat_at = ?, completed_at = ?, error_code = ? WHERE instance_id = ? AND status NOT IN ('ok', 'error')",
    ).bind(failure.heartbeat_at, failure.completed_at, failure.error_code, instanceId)
    const changes = await this.executeBatch([statement])
    if (changes === 0) {
      const status = await this.getSyncRunStatus(instanceId)
      if (status === undefined) throw new Error(`Sync run not found: ${instanceId}`)
      if (status === 'error') return { outcome: 'already_same_terminal', terminal: 'error' }
      if (status === 'ok') return { outcome: 'preserved_opposite_terminal', terminal: 'ok' }
      throw new Error(`Sync run failure not applied: ${instanceId}`)
    }
    return { outcome: 'applied', terminal: 'error' }
  }
}
