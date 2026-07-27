import { canonicalJson } from './canonical-json.ts'
import type {
  CollectionDiffPlanLike,
  CollectionRow,
  D1DatabaseLike,
  D1PreparedStatementLike,
  SyncRunCompletion,
  SyncRunFailure,
  SyncRunRow,
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
  'temperature',
  'first_seen_at',
  'changed_at',
  'missing_since',
  'deleted_at',
] as const

const COLLECTION_SELECT = `SELECT ${COLLECTION_COLUMNS.join(', ')} FROM collection_items ORDER BY user_id, subject_id`
const COLLECTION_INSERT = `INSERT INTO collection_items (${COLLECTION_COLUMNS.join(', ')}) VALUES (${COLLECTION_COLUMNS.map(() => '?').join(', ')})`
const COLLECTION_UPDATE = `UPDATE collection_items SET ${COLLECTION_COLUMNS.slice(2).map((column) => `${column} = ?`).join(', ')} WHERE user_id = ? AND subject_id = ?`
const FIRST_MISSING_UPDATE = 'UPDATE collection_items SET missing_since = ? WHERE user_id = ? AND subject_id = ?'
const CONFIRMED_DELETED_UPDATE = 'UPDATE collection_items SET deleted_at = ? WHERE user_id = ? AND subject_id = ?'
const MAX_BATCH_STATEMENTS = 50
const CLASSIFIED_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

interface PendingWrite {
  userId: string
  subjectId: number
  order: number
  statement: D1PreparedStatementLike
}

function collectionValues(row: CollectionRow): unknown[] {
  return COLLECTION_COLUMNS.map((column) => row[column])
}

function collectionUpdateValues(row: CollectionRow): unknown[] {
  return [...COLLECTION_COLUMNS.slice(2).map((column) => row[column]), row.user_id, row.subject_id]
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
    temperature,
    first_seen_at: requireInteger(raw.first_seen_at, 'first_seen_at'),
    changed_at: requireInteger(raw.changed_at, 'changed_at'),
    missing_since: nullableInteger(raw.missing_since, 'missing_since'),
    deleted_at: nullableInteger(raw.deleted_at, 'deleted_at'),
  }
}

function assertClassifiedErrorCode(errorCode: string | null): void {
  if (errorCode !== null && !CLASSIFIED_ERROR_CODE.test(errorCode)) {
    throw new Error('sync_runs.error_code must be a classified error code')
  }
}

export class D1StateStore {
  constructor(
    private readonly database: D1DatabaseLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async listCollectionRows(): Promise<CollectionRow[]> {
    const result = await this.database.prepare(COLLECTION_SELECT).all<Record<string, unknown>>()
    return result.results.map(decodeCollectionRow)
  }

  async applyCollectionDiff(plan: CollectionDiffPlanLike): Promise<{ rowsWritten: number }> {
    const writes: PendingWrite[] = []
    const addFullUpdate = (row: CollectionRow, order: number) => {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order,
        statement: this.database.prepare(COLLECTION_UPDATE).bind(...collectionUpdateValues(row)),
      })
    }

    for (const row of plan.inserts) {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order: 4,
        statement: this.database.prepare(COLLECTION_INSERT).bind(...collectionValues(row)),
      })
    }
    for (const row of plan.updates) addFullUpdate(row, 3)
    for (const row of plan.firstMissing) {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order: 2,
        statement: this.database.prepare(FIRST_MISSING_UPDATE).bind(row.missing_since, row.user_id, row.subject_id),
      })
    }
    for (const row of plan.confirmedDeleted) {
      writes.push({
        userId: row.user_id,
        subjectId: row.subject_id,
        order: 1,
        statement: this.database.prepare(CONFIRMED_DELETED_UPDATE).bind(row.deleted_at, row.user_id, row.subject_id),
      })
    }
    for (const row of plan.restored) addFullUpdate(row, 0)

    writes.sort(compareWrites)
    for (let offset = 0; offset < writes.length; offset += MAX_BATCH_STATEMENTS) {
      await this.database.batch(writes.slice(offset, offset + MAX_BATCH_STATEMENTS).map(({ statement }) => statement))
    }
    return { rowsWritten: writes.length }
  }

  async getAppState<T>(key: string): Promise<T | undefined> {
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
    return envelope.value as T
  }

  async putAppState<T>(key: string, value: T): Promise<void> {
    const valueJson = canonicalJson({ schema_version: 1, value })
    const statement = this.database.prepare(
      'INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    ).bind(key, valueJson, this.now())
    await this.database.batch([statement])
  }

  async startSyncRun(row: SyncRunRow): Promise<void> {
    assertClassifiedErrorCode(row.error_code)
    const columns = [
      'instance_id', 'status', 'stage', 'generation', 'collection_count', 'changed_count',
      'missing_count', 'deleted_count', 'media_selected_count', 'media_granted_count',
      'input_hash', 'public_hash', 'error_code', 'started_at', 'heartbeat_at', 'completed_at',
    ] as const
    const statement = this.database.prepare(
      `INSERT INTO sync_runs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).bind(...columns.map((column) => row[column]))
    await this.database.batch([statement])
  }

  async updateSyncRun(instanceId: string, update: SyncRunUpdate): Promise<void> {
    const optionalColumns = [
      'generation', 'collection_count', 'changed_count', 'missing_count', 'deleted_count',
      'media_selected_count', 'media_granted_count', 'input_hash', 'public_hash',
    ] as const
    const present = optionalColumns.filter((column) => Object.hasOwn(update, column))
    const columns = ['stage', 'heartbeat_at', ...present] as const
    const statement = this.database.prepare(
      `UPDATE sync_runs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE instance_id = ?`,
    ).bind(...columns.map((column) => update[column]), instanceId)
    await this.database.batch([statement])
  }

  async completeSyncRun(instanceId: string, completion: SyncRunCompletion): Promise<void> {
    const statement = this.database.prepare(
      "UPDATE sync_runs SET status = 'ok', stage = 'complete', heartbeat_at = ?, completed_at = ?, generation = COALESCE(?, generation), input_hash = COALESCE(?, input_hash), public_hash = COALESCE(?, public_hash), error_code = NULL WHERE instance_id = ?",
    ).bind(
      completion.heartbeat_at,
      completion.completed_at,
      completion.generation ?? null,
      completion.input_hash ?? null,
      completion.public_hash ?? null,
      instanceId,
    )
    await this.database.batch([statement])
  }

  async failSyncRun(instanceId: string, failure: SyncRunFailure): Promise<void> {
    assertClassifiedErrorCode(failure.error_code)
    const statement = this.database.prepare(
      "UPDATE sync_runs SET status = 'error', heartbeat_at = ?, completed_at = ?, error_code = ? WHERE instance_id = ?",
    ).bind(failure.heartbeat_at, failure.completed_at, failure.error_code, instanceId)
    await this.database.batch([statement])
  }
}
