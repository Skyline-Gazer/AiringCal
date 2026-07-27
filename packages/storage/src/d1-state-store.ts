import { canonicalJson } from './canonical-json.ts'
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
const COLLECTION_INSERT = `INSERT INTO collection_items (${COLLECTION_COLUMNS.join(', ')}) VALUES (${COLLECTION_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(user_id, subject_id) DO UPDATE SET collection_type = excluded.collection_type, rate = excluded.rate, tags_json = excluded.tags_json, comment = excluded.comment, ep_status = excluded.ep_status, vol_status = excluded.vol_status, upstream_updated_at = excluded.upstream_updated_at, subject_json = excluded.subject_json, content_hash = excluded.content_hash, state_version = collection_items.state_version, temperature = excluded.temperature, first_seen_at = MIN(collection_items.first_seen_at, excluded.first_seen_at), changed_at = excluded.changed_at, missing_since = excluded.missing_since, deleted_at = excluded.deleted_at WHERE collection_items.state_version = 1 AND collection_items.missing_since IS NULL AND collection_items.deleted_at IS NULL AND (excluded.changed_at > collection_items.changed_at OR (excluded.changed_at = collection_items.changed_at AND excluded.content_hash > collection_items.content_hash COLLATE BINARY))`
const COLLECTION_UPDATE_FIELDS = COLLECTION_COLUMNS.slice(2).map((column) => `${column} = ?`).join(', ')
const COLLECTION_UPDATE = `UPDATE collection_items SET ${COLLECTION_UPDATE_FIELDS} WHERE user_id = ? AND subject_id = ? AND state_version = ?`
const COLLECTION_RESTORE = `UPDATE collection_items SET ${COLLECTION_UPDATE_FIELDS} WHERE user_id = ? AND subject_id = ? AND state_version = ?`
const FIRST_MISSING_UPDATE = 'UPDATE collection_items SET missing_since = ?, state_version = ? WHERE user_id = ? AND subject_id = ? AND state_version = ?'
const CONFIRMED_DELETED_UPDATE = 'UPDATE collection_items SET deleted_at = ?, state_version = ? WHERE user_id = ? AND subject_id = ? AND state_version = ?'
const MAX_BATCH_STATEMENTS = 50
const CLASSIFIED_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

interface PendingWrite {
  userId: string
  subjectId: number
  order: number
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
    if (current && COLLECTION_COLUMNS.every((column) => current[column] === write.planned[column])) return
    throw new Error(`Stale collection diff conflict: ${write.userId}:${write.subjectId}`)
  }

  private async syncRunStatus(instanceId: string): Promise<string | undefined> {
    const row = await this.database
      .prepare('SELECT status FROM sync_runs WHERE instance_id = ?')
      .bind(instanceId)
      .first<{ status: unknown }>()
    if (row === null) return undefined
    if (typeof row.status !== 'string') throw new Error(`Invalid sync run status: ${instanceId}`)
    return row.status
  }

  async listCollectionRows(): Promise<CollectionRow[]> {
    const result = await this.database.prepare(COLLECTION_SELECT).all<Record<string, unknown>>()
    return result.results.map(decodeCollectionRow)
  }

  async applyCollectionDiff(plan: CollectionDiffPlanLike): Promise<{ rowsWritten: number }> {
    const writes: PendingWrite[] = []
    const addBusinessUpdate = (row: CollectionRow, order: number) => {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order,
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
    for (let offset = 0; offset < writes.length; offset += MAX_BATCH_STATEMENTS) {
      const chunk = writes.slice(offset, offset + MAX_BATCH_STATEMENTS)
      const changes = await this.executeBatchChanges(chunk.map(({ statement }) => statement))
      rowsWritten += changes.reduce((total, count) => total + count, 0)
      for (let index = 0; index < chunk.length; index++) {
        if (changes[index] === 0) await this.reconcileCollectionNoChange(chunk[index]!)
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
    const columns = [
      'instance_id', 'status', 'stage', 'generation', 'collection_count', 'changed_count',
      'missing_count', 'deleted_count', 'media_selected_count', 'media_granted_count',
      'input_hash', 'public_hash', 'error_code', 'started_at', 'heartbeat_at', 'completed_at',
    ] as const
    const statement = this.database.prepare(
      `INSERT INTO sync_runs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(instance_id) DO NOTHING`,
    ).bind(...columns.map((column) => row[column]))
    const changes = await this.executeBatch([statement])
    if (changes === 0 && await this.syncRunStatus(row.instance_id) === undefined) {
      throw new Error(`Sync run not found after start: ${row.instance_id}`)
    }
  }

  async updateSyncRun(instanceId: string, update: SyncRunUpdate): Promise<void> {
    const optionalColumns = [
      'generation', 'collection_count', 'changed_count', 'missing_count', 'deleted_count',
      'media_selected_count', 'media_granted_count', 'input_hash', 'public_hash',
    ] as const
    const present = optionalColumns.filter((column) => update[column] !== undefined)
    const columns = ['stage', 'heartbeat_at', ...present] as const
    const statement = this.database.prepare(
      `UPDATE sync_runs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE instance_id = ? AND status NOT IN ('ok', 'error')`,
    ).bind(...columns.map((column) => update[column]), instanceId)
    const changes = await this.executeBatch([statement])
    if (changes === 0) {
      const status = await this.syncRunStatus(instanceId)
      if (status === undefined) throw new Error(`Sync run not found: ${instanceId}`)
      if (status === 'ok' || status === 'error') throw new Error(`Sync run already terminal: ${status}`)
      throw new Error(`Sync run update not applied: ${instanceId}`)
    }
  }

  async completeSyncRun(instanceId: string, completion: SyncRunCompletion): Promise<SyncTerminalTransitionResult> {
    const statement = this.database.prepare(
      "UPDATE sync_runs SET status = 'ok', stage = 'complete', heartbeat_at = ?, completed_at = ?, generation = COALESCE(?, generation), input_hash = COALESCE(?, input_hash), public_hash = COALESCE(?, public_hash), error_code = NULL WHERE instance_id = ? AND status NOT IN ('ok', 'error')",
    ).bind(
      completion.heartbeat_at,
      completion.completed_at,
      completion.generation ?? null,
      completion.input_hash ?? null,
      completion.public_hash ?? null,
      instanceId,
    )
    const changes = await this.executeBatch([statement])
    if (changes === 0) {
      const status = await this.syncRunStatus(instanceId)
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
      const status = await this.syncRunStatus(instanceId)
      if (status === undefined) throw new Error(`Sync run not found: ${instanceId}`)
      if (status === 'error') return { outcome: 'already_same_terminal', terminal: 'error' }
      if (status === 'ok') return { outcome: 'preserved_opposite_terminal', terminal: 'ok' }
      throw new Error(`Sync run failure not applied: ${instanceId}`)
    }
    return { outcome: 'applied', terminal: 'error' }
  }
}
