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
  PublicationPendingCleanupResult,
  PublicationSourceWatermarkV1,
  PublicSnapshotPointerV1,
  PublicationWriteOwner,
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
const SUBJECT_MEDIA_SELECT_ONE = `SELECT ${SUBJECT_MEDIA_COLUMNS.join(', ')} FROM subject_media WHERE subject_id = ?`
const SUBJECT_MEDIA_UPSERT = `INSERT INTO subject_media (${SUBJECT_MEDIA_COLUMNS.join(', ')}) VALUES (${SUBJECT_MEDIA_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(subject_id) DO UPDATE SET ${SUBJECT_MEDIA_COLUMNS.slice(1).map((column) => `${column} = excluded.${column}`).join(', ')} WHERE ${SUBJECT_MEDIA_COLUMNS.slice(1).map((column) => `subject_media.${column} IS NOT excluded.${column}`).join(' OR ')}`
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
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/
const PUBLICATION_POINTER_KEYS = [
  'schema_version',
  'generation',
  'content_hash',
  'r2_key',
  'published_at',
] as const
const PUBLICATION_WRITE_CLAIM_KEY = 'public:write-claim'
const PUBLICATION_SOURCE_WATERMARK_KEY = 'public:source-watermark'
export const PUBLICATION_WRITE_LEASE_SECONDS = 60

interface PublicationWriteClaim extends PublicationWriteOwner {
  candidate: PublicSnapshotPointerV1
  expires_at: number
}

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

function decodePublicationPointer(value: unknown): PublicSnapshotPointerV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid publication state')
  }
  const pointer = value as Record<string, unknown>
  const keys = Object.keys(pointer)
  if (
    pointer.schema_version !== 1
    || !PUBLICATION_POINTER_KEYS.every((key) => Object.hasOwn(pointer, key))
    || keys.some((key) => !PUBLICATION_POINTER_KEYS.includes(
      key as typeof PUBLICATION_POINTER_KEYS[number],
    ))
    || !Number.isSafeInteger(pointer.generation)
    || (pointer.generation as number) < 0
    || typeof pointer.content_hash !== 'string'
    || !LOWERCASE_SHA256.test(pointer.content_hash)
    || typeof pointer.r2_key !== 'string'
    || !Number.isSafeInteger(pointer.published_at)
    || (pointer.published_at as number) < 0
  ) {
    throw new Error('Invalid publication state')
  }
  if (
    pointer.r2_key
    !== `snapshots/v1/${pointer.generation}-${pointer.content_hash}.json`
  ) {
    throw new Error('Invalid publication object key')
  }
  return pointer as unknown as PublicSnapshotPointerV1
}

function decodeAppStateEnvelope(valueJson: unknown): unknown {
  if (typeof valueJson !== 'string') throw new Error('Invalid app_state JSON')
  let parsed: unknown
  try {
    parsed = JSON.parse(valueJson)
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

function decodePublicationWriteClaim(value: unknown): PublicationWriteClaim {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid publication write claim')
  }
  const claim = value as Record<string, unknown>
  if (
    Object.keys(claim).length !== 4
    || !Object.hasOwn(claim, 'candidate')
    || !Object.hasOwn(claim, 'publication_id')
    || !Object.hasOwn(claim, 'attempt_token')
    || !Object.hasOwn(claim, 'expires_at')
    || typeof claim.publication_id !== 'string'
    || claim.publication_id.length === 0
    || claim.publication_id.length > 128
    || typeof claim.attempt_token !== 'string'
    || claim.attempt_token.length === 0
    || claim.attempt_token.length > 128
    || !Number.isSafeInteger(claim.expires_at)
    || (claim.expires_at as number) < 0
  ) throw new Error('Invalid publication write claim')
  return {
    candidate: decodePublicationPointer(claim.candidate),
    publication_id: claim.publication_id,
    attempt_token: claim.attempt_token,
    expires_at: validatePublicationLeaseTime(claim.expires_at as number),
  }
}

function validatePublicationWriteOwner(owner: PublicationWriteOwner): PublicationWriteOwner {
  if (
    typeof owner !== 'object'
    || owner === null
    || typeof owner.publication_id !== 'string'
    || owner.publication_id.length === 0
    || owner.publication_id.length > 128
    || typeof owner.attempt_token !== 'string'
    || owner.attempt_token.length === 0
    || owner.attempt_token.length > 128
  ) {
    throw new Error('Invalid publication write owner')
  }
  return {
    publication_id: owner.publication_id,
    attempt_token: owner.attempt_token,
  }
}

function decodePublicationSourceWatermark(value: unknown): PublicationSourceWatermarkV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid publication source watermark')
  }
  const source = value as Record<string, unknown>
  if (
    Object.keys(source).length !== 4
    || source.schema_version !== 1
    || !Number.isSafeInteger(source.source_observed_at)
    || (source.source_observed_at as number) < 0
    || typeof source.publication_id !== 'string'
    || source.publication_id.length === 0
    || source.publication_id.length > 128
    || typeof source.content_hash !== 'string'
    || !LOWERCASE_SHA256.test(source.content_hash)
  ) throw new Error('Invalid publication source watermark')
  return {
    schema_version: 1,
    source_observed_at: source.source_observed_at as number,
    publication_id: source.publication_id,
    content_hash: source.content_hash,
  }
}

function publicationSourceRelation(
  incoming: PublicationSourceWatermarkV1,
  current: PublicationSourceWatermarkV1 | undefined,
): 'newer' | 'exact' | 'stale' | 'conflict' {
  if (current === undefined) return 'newer'
  if (incoming.source_observed_at !== current.source_observed_at) {
    return incoming.source_observed_at > current.source_observed_at ? 'newer' : 'stale'
  }
  if (incoming.publication_id !== current.publication_id) {
    return incoming.publication_id > current.publication_id ? 'newer' : 'stale'
  }
  return incoming.content_hash === current.content_hash ? 'exact' : 'conflict'
}

function validatePublicationLeaseTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid publication lease time')
  }
  try {
    new Date(value * 1_000).toISOString()
  } catch {
    throw new Error('Invalid publication lease time')
  }
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

function subjectMediaValues(row: SubjectMediaRow): unknown[] {
  return SUBJECT_MEDIA_COLUMNS.map((column) => row[column])
}

function priorStateVersion(row: CollectionRow): number {
  if (!Number.isSafeInteger(row.state_version) || row.state_version <= 1) {
    throw new Error('Invalid planned collection state_version')
  }
  return row.state_version - 1
}

function assertClassifiedErrorCode(errorCode: string | null, column = 'sync_runs.error_code'): void {
  if (errorCode !== null && !CLASSIFIED_ERROR_CODE.test(errorCode)) {
    throw new Error(`${column} must be a classified error code`)
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

  private async publicationState(): Promise<{
    verified?: PublicSnapshotPointerV1
    pending?: PublicSnapshotPointerV1
    claim?: PublicationWriteClaim
    source?: PublicationSourceWatermarkV1
  }> {
    const result = await this.database.prepare(
      'SELECT key, value_json FROM app_state WHERE key IN (?, ?, ?, ?) ORDER BY key',
    ).bind(
      'public:pending',
      'public:verified',
      PUBLICATION_WRITE_CLAIM_KEY,
      PUBLICATION_SOURCE_WATERMARK_KEY,
    ).all<{
      key: unknown
      value_json: unknown
    }>()
    if (
      result === null
      || typeof result !== 'object'
      || result.success !== true
      || !Array.isArray(result.results)
    ) throw new Error('Invalid D1 publication state result')

    const pair: {
      verified?: PublicSnapshotPointerV1
      pending?: PublicSnapshotPointerV1
      claim?: PublicationWriteClaim
      source?: PublicationSourceWatermarkV1
    } = {}
    for (const row of result.results) {
      if (
        row.key !== 'public:pending'
        && row.key !== 'public:verified'
        && row.key !== PUBLICATION_WRITE_CLAIM_KEY
        && row.key !== PUBLICATION_SOURCE_WATERMARK_KEY
      ) {
        throw new Error('Invalid D1 publication state key')
      }
      const value = decodeAppStateEnvelope(row.value_json)
      if (row.key === 'public:pending') pair.pending = decodePublicationPointer(value)
      else if (row.key === 'public:verified') pair.verified = decodePublicationPointer(value)
      else if (row.key === PUBLICATION_WRITE_CLAIM_KEY) {
        pair.claim = decodePublicationWriteClaim(value)
      } else pair.source = decodePublicationSourceWatermark(value)
    }
    return pair
  }

  private publicationSourceCasStatement(
    source: PublicationSourceWatermarkV1,
    observed: PublicationSourceWatermarkV1 | undefined,
  ): D1PreparedStatementLike {
    const valueJson = canonicalJson({ schema_version: 1, value: source })
    if (observed === undefined) {
      return this.database.prepare(
        `INSERT INTO app_state (key, value_json, updated_at)
         SELECT ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?)
         ON CONFLICT(key) DO NOTHING`,
      ).bind(
        PUBLICATION_SOURCE_WATERMARK_KEY,
        valueJson,
        source.source_observed_at,
        PUBLICATION_SOURCE_WATERMARK_KEY,
      )
    }
    return this.database.prepare(
      `UPDATE app_state
       SET value_json = ?, updated_at = ?
       WHERE key = ? AND value_json = ? AND updated_at = ?`,
    ).bind(
      valueJson,
      source.source_observed_at,
      PUBLICATION_SOURCE_WATERMARK_KEY,
      canonicalJson({ schema_version: 1, value: observed }),
      observed.source_observed_at,
    )
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

  async getSubjectMediaRow(subjectId: number): Promise<SubjectMediaRow | undefined> {
    const row = await this.database.prepare(SUBJECT_MEDIA_SELECT_ONE)
      .bind(subjectId)
      .first<Record<string, unknown>>()
    return row === null ? undefined : decodeSubjectMediaRow(row)
  }

  async putSubjectMediaRow(row: SubjectMediaRow): Promise<{ rowsWritten: number }> {
    assertClassifiedErrorCode(row.error_code, 'subject_media.error_code')
    const rowsWritten = await this.executeBatch([
      this.database.prepare(SUBJECT_MEDIA_UPSERT).bind(...subjectMediaValues(row)),
    ])
    return { rowsWritten }
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
    return decodeAppStateEnvelope(row.value_json)
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

  async putAppStateIfNewer<T>(key: string, value: T, version: number): Promise<boolean> {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid app_state version')
    const valueJson = canonicalJson({ schema_version: 1, value })
    const statement = this.database.prepare(
      'INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at WHERE app_state.updated_at < excluded.updated_at OR (app_state.updated_at = excluded.updated_at AND app_state.value_json = excluded.value_json)',
    ).bind(key, valueJson, version)
    const changes = await this.executeBatch([statement])
    if (changes !== 0) return true
    const current = await this.database.prepare(
      'SELECT value_json, updated_at FROM app_state WHERE key = ?',
    ).bind(key).first<{ value_json: unknown; updated_at: unknown }>()
    return current !== null && current.value_json === valueJson && current.updated_at === version
  }

  async getVerifiedPublication(): Promise<PublicSnapshotPointerV1 | undefined> {
    return await this.getAppState('public:verified', decodePublicationPointer)
  }

  async getPendingPublication(): Promise<PublicSnapshotPointerV1 | undefined> {
    return await this.getAppState('public:pending', decodePublicationPointer)
  }

  async commitPendingPublication(
    candidate: PublicSnapshotPointerV1,
    publicationSource: PublicationSourceWatermarkV1,
  ): Promise<boolean> {
    const validated = decodePublicationPointer(candidate)
    const source = decodePublicationSourceWatermark(publicationSource)
    if (source.content_hash !== validated.content_hash) {
      throw new Error('Publication source content_hash mismatch')
    }
    const valueJson = canonicalJson({ schema_version: 1, value: validated })
    const candidateJson = canonicalJson(validated)
    const sourceValueJson = canonicalJson({ schema_version: 1, value: source })
    const leaseNow = validatePublicationLeaseTime(this.now())

    for (let attempt = 0; attempt < 3; attempt++) {
      const { verified, pending, claim, source: observedSource } = await this.publicationState()
      const sourceRelation = publicationSourceRelation(source, observedSource)
      if (sourceRelation === 'stale' || sourceRelation === 'conflict') return false
      if (claim && claim.expires_at > leaseNow) return false
      if (
        !(
          (verified === undefined && validated.generation === 1)
          || verified?.generation === validated.generation - 1
        )
      ) return false
      const exactPending = pending && canonicalJson(pending) === candidateJson
      if (sourceRelation === 'exact' && exactPending) return true
      if (sourceRelation === 'exact' && pending !== undefined) return false
      if (
        sourceRelation === 'exact'
        && claim
        && claim.expires_at > leaseNow
      ) return false

      const statements: D1PreparedStatementLike[] = []
      if (sourceRelation === 'newer') {
        statements.push(this.publicationSourceCasStatement(source, observedSource))
      }
      if (claim) {
        const claimValueJson = canonicalJson({ schema_version: 1, value: claim })
        statements.push(this.database.prepare(
          `DELETE FROM app_state
           WHERE key = ? AND value_json = ? AND updated_at = ?
             AND EXISTS (
               SELECT 1 FROM app_state
               WHERE key = ? AND value_json = ? AND updated_at = ?
             )`,
        ).bind(
          PUBLICATION_WRITE_CLAIM_KEY,
          claimValueJson,
          claim.candidate.generation,
          PUBLICATION_SOURCE_WATERMARK_KEY,
          sourceValueJson,
          source.source_observed_at,
        ))
      }

      if (exactPending) {
        const changes = await this.executeBatchChanges(statements)
        if (sourceRelation === 'exact' || changes[0] !== 0) return true
        continue
      }

      if (pending === undefined) {
        statements.push(this.database.prepare(
          `INSERT INTO app_state (key, value_json, updated_at)
           SELECT ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?)
             AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?)
             AND EXISTS (
               SELECT 1 FROM app_state
               WHERE key = ? AND value_json = ? AND updated_at = ?
             )
             AND (
               (? = 1 AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?))
               OR EXISTS (
                 SELECT 1 FROM app_state
                 WHERE key = ? AND updated_at = ?
               )
             )
           ON CONFLICT(key) DO NOTHING`,
        ).bind(
          'public:pending',
          valueJson,
          validated.generation,
          'public:pending',
          PUBLICATION_WRITE_CLAIM_KEY,
          PUBLICATION_SOURCE_WATERMARK_KEY,
          sourceValueJson,
          source.source_observed_at,
          validated.generation,
          'public:verified',
          'public:verified',
          validated.generation - 1,
        ))
      } else {
        const pendingValueJson = canonicalJson({ schema_version: 1, value: pending })
        statements.push(this.database.prepare(
          `UPDATE app_state
           SET value_json = ?, updated_at = ?
           WHERE key = ? AND value_json = ? AND updated_at = ?
             AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?)
             AND EXISTS (
               SELECT 1 FROM app_state
               WHERE key = ? AND value_json = ? AND updated_at = ?
             )
             AND (
               (? = 1 AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?))
               OR EXISTS (
                 SELECT 1 FROM app_state
                 WHERE key = ? AND updated_at = ?
               )
             )`,
        ).bind(
          valueJson,
          validated.generation,
          'public:pending',
          pendingValueJson,
          pending.generation,
          PUBLICATION_WRITE_CLAIM_KEY,
          PUBLICATION_SOURCE_WATERMARK_KEY,
          sourceValueJson,
          source.source_observed_at,
          validated.generation,
          'public:verified',
          'public:verified',
          validated.generation - 1,
        ))
      }
      const changes = await this.executeBatchChanges(statements)
      if (changes.at(-1) !== 0) return true
    }
    return false
  }

  async cleanupStalePendingPublication(
    verifiedCandidate: PublicSnapshotPointerV1,
    publicationSource: PublicationSourceWatermarkV1,
  ): Promise<PublicationPendingCleanupResult> {
    const validated = decodePublicationPointer(verifiedCandidate)
    const source = decodePublicationSourceWatermark(publicationSource)
    if (source.content_hash !== validated.content_hash) {
      throw new Error('Publication source content_hash mismatch')
    }
    const verifiedJson = canonicalJson(validated)
    const verifiedValueJson = canonicalJson({ schema_version: 1, value: validated })
    const sourceValueJson = canonicalJson({ schema_version: 1, value: source })
    const leaseNow = validatePublicationLeaseTime(this.now())

    for (let attempt = 0; attempt < 3; attempt++) {
      const { verified, pending, claim, source: observedSource } = await this.publicationState()
      if (!verified || canonicalJson(verified) !== verifiedJson) return 'conflict'
      const sourceRelation = publicationSourceRelation(source, observedSource)
      if (sourceRelation === 'stale') return 'stale'
      if (sourceRelation === 'conflict') return 'conflict'
      if (claim && claim.expires_at > leaseNow) {
        return pending !== undefined
          && canonicalJson(claim.candidate) === canonicalJson(pending)
          ? 'active'
          : 'conflict'
      }
      if (
        sourceRelation === 'exact'
        && pending === undefined
      ) return claim === undefined ? 'clean' : 'conflict'
      const statements: D1PreparedStatementLike[] = []
      if (sourceRelation === 'newer') {
        statements.push(this.publicationSourceCasStatement(source, observedSource))
      }
      if (claim) {
        const claimValueJson = canonicalJson({ schema_version: 1, value: claim })
        statements.push(this.database.prepare(
          `DELETE FROM app_state
           WHERE key = ? AND value_json = ? AND updated_at = ?
             AND EXISTS (
               SELECT 1 FROM app_state
               WHERE key = ? AND value_json = ? AND updated_at = ?
             )`,
        ).bind(
          PUBLICATION_WRITE_CLAIM_KEY,
          claimValueJson,
          claim.candidate.generation,
          PUBLICATION_SOURCE_WATERMARK_KEY,
          sourceValueJson,
          source.source_observed_at,
        ))
      }
      if (pending === undefined) {
        const changes = await this.executeBatchChanges(statements)
        if (sourceRelation === 'exact' || changes[0] !== 0) return 'clean'
        continue
      }
      const pendingValueJson = canonicalJson({ schema_version: 1, value: pending })
      statements.push(this.database.prepare(
        `DELETE FROM app_state
         WHERE key = ? AND value_json = ? AND updated_at = ?
           AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?)
           AND EXISTS (
             SELECT 1 FROM app_state
             WHERE key = ? AND value_json = ? AND updated_at = ?
           )
           AND EXISTS (
             SELECT 1 FROM app_state
             WHERE key = ? AND value_json = ? AND updated_at = ?
           )`,
      ).bind(
        'public:pending',
        pendingValueJson,
        pending.generation,
        PUBLICATION_WRITE_CLAIM_KEY,
        PUBLICATION_SOURCE_WATERMARK_KEY,
        sourceValueJson,
        source.source_observed_at,
        'public:verified',
        verifiedValueJson,
        validated.generation,
      ))
      const changes = await this.executeBatchChanges(statements)
      if (changes.at(-1) !== 0) return 'cleaned'
    }
    return 'conflict'
  }

  async confirmPublicationAuthorized(
    candidate: PublicSnapshotPointerV1,
    publicationSource: PublicationSourceWatermarkV1,
  ): Promise<'authorized' | 'already_verified' | 'stale' | 'conflict'> {
    const validated = decodePublicationPointer(candidate)
    const source = decodePublicationSourceWatermark(publicationSource)
    if (source.content_hash !== validated.content_hash) return 'conflict'
    const { verified, pending, source: observedSource } = await this.publicationState()
    const sourceRelation = publicationSourceRelation(source, observedSource)
    if (sourceRelation === 'stale') return 'stale'
    if (sourceRelation !== 'exact') return 'conflict'
    const candidateJson = canonicalJson(validated)
    if (verified && canonicalJson(verified) === candidateJson) return 'already_verified'
    if (
      pending
      && canonicalJson(pending) === candidateJson
      && (
        (verified === undefined && validated.generation === 1)
        || verified?.generation === validated.generation - 1
      )
    ) return 'authorized'
    return 'conflict'
  }

  async claimPublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
    publicationSource: PublicationSourceWatermarkV1,
  ): Promise<'claimed' | 'busy' | 'already_verified' | 'conflict'> {
    const validated = decodePublicationPointer(candidate)
    const validatedOwner = validatePublicationWriteOwner(owner)
    const source = decodePublicationSourceWatermark(publicationSource)
    if (
      source.content_hash !== validated.content_hash
      || source.publication_id !== validatedOwner.publication_id
    ) return 'conflict'
    const leaseNow = validatePublicationLeaseTime(this.now())
    const expiresAt = validatePublicationLeaseTime(
      leaseNow + PUBLICATION_WRITE_LEASE_SECONDS,
    )
    const pointerValueJson = canonicalJson({ schema_version: 1, value: validated })
    const candidateJson = canonicalJson(validated)
    const nextClaim: PublicationWriteClaim = {
      candidate: validated,
      ...validatedOwner,
      expires_at: expiresAt,
    }
    const nextClaimValueJson = canonicalJson({ schema_version: 1, value: nextClaim })
    const sourceValueJson = canonicalJson({ schema_version: 1, value: source })

    for (let attempt = 0; attempt < 3; attempt++) {
      const {
        verified,
        pending,
        claim: observedClaim,
        source: observedSource,
      } = await this.publicationState()
      if (publicationSourceRelation(source, observedSource) !== 'exact') return 'conflict'
      if (verified && canonicalJson(verified) === candidateJson) return 'already_verified'
      const authorized = (
        pending
        && canonicalJson(pending) === candidateJson
        && (
          (verified === undefined && validated.generation === 1)
          || verified?.generation === validated.generation - 1
        )
      )
      if (!authorized) return 'conflict'

      if (observedClaim === undefined) {
        const inserted = await this.executeBatch([
          this.database.prepare(
            `INSERT INTO app_state (key, value_json, updated_at)
             SELECT ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM app_state
               WHERE key = ? AND value_json = ? AND updated_at = ?
             )
             AND EXISTS (
               SELECT 1 FROM app_state
               WHERE key = ? AND value_json = ? AND updated_at = ?
             )
             AND (
               (? = 1 AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?))
               OR EXISTS (
                 SELECT 1 FROM app_state
                 WHERE key = ? AND updated_at = ?
               )
             )
             ON CONFLICT(key) DO NOTHING`,
          ).bind(
            PUBLICATION_WRITE_CLAIM_KEY,
            nextClaimValueJson,
            validated.generation,
            'public:pending',
            pointerValueJson,
            validated.generation,
            PUBLICATION_SOURCE_WATERMARK_KEY,
            sourceValueJson,
            source.source_observed_at,
            validated.generation,
            'public:verified',
            'public:verified',
            validated.generation - 1,
          ),
        ])
        if (inserted !== 0) return 'claimed'
        continue
      }

      if (canonicalJson(observedClaim.candidate) !== candidateJson) return 'busy'
      if (
        observedClaim.publication_id === validatedOwner.publication_id
        && observedClaim.attempt_token === validatedOwner.attempt_token
        && observedClaim.expires_at > leaseNow
      ) return 'claimed'
      if (observedClaim.expires_at > leaseNow) return 'busy'

      const observedClaimValueJson = canonicalJson({
        schema_version: 1,
        value: observedClaim,
      })
      const replaced = await this.executeBatch([
        this.database.prepare(
          `UPDATE app_state
           SET value_json = ?, updated_at = ?
           WHERE key = ? AND value_json = ? AND updated_at = ?
             AND EXISTS (
               SELECT 1 FROM app_state AS pending
               WHERE pending.key = ? AND pending.value_json = ? AND pending.updated_at = ?
             )
             AND EXISTS (
               SELECT 1 FROM app_state AS source
               WHERE source.key = ? AND source.value_json = ? AND source.updated_at = ?
             )
             AND (
               (? = 1 AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?))
               OR EXISTS (
                 SELECT 1 FROM app_state AS verified
                 WHERE verified.key = ? AND verified.updated_at = ?
               )
             )`,
        ).bind(
          nextClaimValueJson,
          validated.generation,
          PUBLICATION_WRITE_CLAIM_KEY,
          observedClaimValueJson,
          validated.generation,
          'public:pending',
          pointerValueJson,
          validated.generation,
          PUBLICATION_SOURCE_WATERMARK_KEY,
          sourceValueJson,
          source.source_observed_at,
          validated.generation,
          'public:verified',
          'public:verified',
          validated.generation - 1,
        ),
      ])
      if (replaced !== 0) return 'claimed'
    }
    return 'busy'
  }

  async confirmPublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
    publicationSource: PublicationSourceWatermarkV1,
  ): Promise<'active' | 'expired' | 'already_verified' | 'conflict'> {
    const validated = decodePublicationPointer(candidate)
    const validatedOwner = validatePublicationWriteOwner(owner)
    const source = decodePublicationSourceWatermark(publicationSource)
    if (
      source.content_hash !== validated.content_hash
      || source.publication_id !== validatedOwner.publication_id
    ) return 'conflict'
    const leaseNow = validatePublicationLeaseTime(this.now())
    const { verified, claim, source: observedSource } = await this.publicationState()
    if (publicationSourceRelation(source, observedSource) !== 'exact') return 'conflict'
    const candidateJson = canonicalJson(validated)
    if (verified && canonicalJson(verified) === candidateJson) return 'already_verified'
    if (
      claim
      && canonicalJson(claim.candidate) === candidateJson
      && claim.publication_id === validatedOwner.publication_id
      && claim.attempt_token === validatedOwner.attempt_token
    ) return claim.expires_at > leaseNow ? 'active' : 'expired'
    return 'conflict'
  }

  async releasePublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ): Promise<void> {
    const validated = decodePublicationPointer(candidate)
    const validatedOwner = validatePublicationWriteOwner(owner)
    const { claim } = await this.publicationState()
    if (
      !claim
      || canonicalJson(claim.candidate) !== canonicalJson(validated)
      || claim.publication_id !== validatedOwner.publication_id
      || claim.attempt_token !== validatedOwner.attempt_token
    ) return
    const claimValueJson = canonicalJson({ schema_version: 1, value: claim })
    await this.executeBatch([
      this.database.prepare(
        'DELETE FROM app_state WHERE key = ? AND value_json = ? AND updated_at = ?',
      ).bind(PUBLICATION_WRITE_CLAIM_KEY, claimValueJson, validated.generation),
    ])
  }

  async markPublicationPublished(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
    publicationSource: PublicationSourceWatermarkV1,
  ): Promise<void> {
    const validated = decodePublicationPointer(candidate)
    const validatedOwner = validatePublicationWriteOwner(owner)
    const source = decodePublicationSourceWatermark(publicationSource)
    if (
      source.content_hash !== validated.content_hash
      || source.publication_id !== validatedOwner.publication_id
    ) throw new Error('Publication source conflict')
    const leaseNow = validatePublicationLeaseTime(this.now())
    const valueJson = canonicalJson({ schema_version: 1, value: validated })
    const state = await this.publicationState()
    if (publicationSourceRelation(source, state.source) !== 'exact') {
      throw new Error('Publication source conflict')
    }
    if (state.verified && canonicalJson(state.verified) === canonicalJson(validated)) return
    if (
      !state.claim
      || canonicalJson(state.claim.candidate) !== canonicalJson(validated)
      || state.claim.publication_id !== validatedOwner.publication_id
      || state.claim.attempt_token !== validatedOwner.attempt_token
      || state.claim.expires_at <= leaseNow
    ) throw new Error('Publication write claim conflict')
    const claimValueJson = canonicalJson({ schema_version: 1, value: state.claim })
    const sourceValueJson = canonicalJson({ schema_version: 1, value: source })
    const verifiedUpsert = this.database.prepare(
      `INSERT INTO app_state (key, value_json, updated_at)
       SELECT ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM app_state
         WHERE key = ? AND value_json = ? AND updated_at = ?
       )
       AND EXISTS (
         SELECT 1 FROM app_state
         WHERE key = ? AND value_json = ? AND updated_at = ?
       )
       AND EXISTS (
         SELECT 1 FROM app_state
         WHERE key = ? AND value_json = ? AND updated_at = ?
       )
       AND (
         (? = 1 AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?))
         OR EXISTS (
           SELECT 1 FROM app_state
           WHERE key = ? AND updated_at = ?
         )
       )
       ON CONFLICT(key) DO UPDATE
       SET value_json = excluded.value_json, updated_at = excluded.updated_at
       WHERE app_state.updated_at = excluded.updated_at - 1`,
    ).bind(
      'public:verified',
      valueJson,
      validated.generation,
      'public:pending',
      valueJson,
      validated.generation,
      PUBLICATION_WRITE_CLAIM_KEY,
      claimValueJson,
      validated.generation,
      PUBLICATION_SOURCE_WATERMARK_KEY,
      sourceValueJson,
      source.source_observed_at,
      validated.generation,
      'public:verified',
      'public:verified',
      validated.generation - 1,
    )
    const pendingDelete = this.database.prepare(
      'DELETE FROM app_state WHERE key = ? AND value_json = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM app_state AS verified WHERE verified.key = ? AND verified.value_json = ? AND verified.updated_at = ?)',
    ).bind(
      'public:pending',
      valueJson,
      validated.generation,
      'public:verified',
      valueJson,
      validated.generation,
    )
    const claimDelete = this.database.prepare(
      'DELETE FROM app_state WHERE key = ? AND value_json = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM app_state AS verified WHERE verified.key = ? AND verified.value_json = ? AND verified.updated_at = ?)',
    ).bind(
      PUBLICATION_WRITE_CLAIM_KEY,
      claimValueJson,
      validated.generation,
      'public:verified',
      valueJson,
      validated.generation,
    )
    await this.executeBatchChanges([verifiedUpsert, pendingDelete, claimDelete])
    const verified = await this.getVerifiedPublication()
    if (canonicalJson(verified) !== canonicalJson(validated)) {
      throw new Error('Publication write claim conflict')
    }
  }

  async deleteAppStateKeys(keys: string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += MAX_BATCH_STATEMENTS) {
      const chunk = keys.slice(offset, offset + MAX_BATCH_STATEMENTS)
      await this.executeBatch(chunk.map((key) =>
        this.database.prepare('DELETE FROM app_state WHERE key = ?').bind(key)))
    }
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
