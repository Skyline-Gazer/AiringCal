import { planCollectionDiff, type NormalizedCollection } from '@airing-cal/domain'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { withSessionLock } from './migrate.ts'
import type { SubjectSession, MediaCandidate } from '../media/refresh.ts'
import {
  assertCompleteStateInput,
  assertMediaResultInput,
  assertPendingPublicationInput,
  assertPublicationClaimInput,
  assertPublicationVerificationInput,
  assertRunFinishInput,
  assertRunStartInput,
  assertUnclaimedPendingCleanupInput,
} from './persistence-validation.ts'

type SubjectPayload = Readonly<{
  id: number
  type?: number
  name: string
  name_cn?: string
  summary?: string
  nsfw?: boolean
  date?: string
  eps?: number
  total_episodes?: number
  images?: Readonly<{ common?: string | null; large?: string | null }>
  rating?: Readonly<{ score: number; rank: number; total: number }>
}>

type CollectionPayload = Readonly<{
  type?: number
  collection_type?: number
  rate?: number | null
  tags?: readonly string[]
  comment?: string
  ep_status?: number
  vol_status?: number
  private?: boolean
}>

type CalendarPayload = Readonly<{
  weekday: Readonly<{ id: number; en?: string; cn?: string; ja?: string }>
  subject_id: number
}>

type MediaDetail = Readonly<{
  id?: number
  type?: number
  name?: string
  name_cn?: string
  summary?: string
  nsfw?: boolean
  date?: string
  eps?: number
  total_episodes?: number
}>

type MediaMetadata = Readonly<{
  exists: boolean | null
  nsfw: boolean
  checked_at: number
  expires_at?: number | null
  reason: 'subject_detail' | 'not_found' | 'not_found_or_restricted' | 'network_error' | 'upstream_error'
}>

type ImageReference = Readonly<{ hash: string; uri: string; r2_key: string }>
type MediaImageRefs = Readonly<{ common: ImageReference | null; large: ImageReference | null }>
type MediaComponentStatus = 'pending' | 'success' | 'failed' | 'missing' | 'not_found' | 'not_modified'
type MediaStatus = Readonly<{
  detail?: MediaComponentStatus
  metadata?: MediaComponentStatus
  image?: MediaComponentStatus
}>

type RunCounts = Readonly<Partial<Record<
  | 'users'
  | 'collections'
  | 'inserted'
  | 'updated'
  | 'unchanged'
  | 'missing'
  | 'deleted'
  | 'restored'
  | 'mediaSelected'
  | 'mediaSucceeded'
  | 'mediaFailed',
  number
>>>

type RunStageDurations = Readonly<Partial<Record<
  | 'collection'
  | 'calendar'
  | 'completeState'
  | 'media'
  | 'publication'
  | 'backup'
  | 'notification',
  number
>>>

type RunComponentResult = 'success' | 'no_change' | 'partial' | 'failed' | 'skipped' | 'not_attempted'
type RunComponents = Readonly<Partial<Record<
  'collection' | 'calendar' | 'media' | 'publication' | 'backup' | 'notification',
  RunComponentResult
>>>

export type SubjectInput = {
  id: number
  subjectType: number
  payload: SubjectPayload
  contentHash: string
  upstreamUpdatedAt: string | null
}

export type CollectionInput = {
  payload: CollectionPayload
  contentHash: string
  upstreamUpdatedAt: string | null
}

export type CompleteStateInput = {
  runId: string
  observedAt: string
  users: readonly {
    id: string
    upstreamUserId: string
    items: readonly { subject: SubjectInput; collection: CollectionInput }[]
  }[]
  calendarEntries: readonly {
    weekdayId: number
    subjectId: number
    subject: SubjectInput
    payload: CalendarPayload
  }[]
}

export type RunStartInput = {
  id: string
  source: 'scheduled' | 'manual'
  mode: 'shadow' | 'live'
  stage: string
  status: 'running' | 'skipped'
  startedAt: string
  heartbeatAt: string
  gitSha: string
}

export type SanitizedError = { category: string; code: string; attemptCount: number; stage: string }

export type RunFinishInput = {
  id: string
  stage: string
  status: 'success' | 'no_change' | 'partial' | 'failed' | 'skipped'
  heartbeatAt: string
  finishedAt: string
  counts: RunCounts
  stageDurations: RunStageDurations
  sanitizedError: SanitizedError | null
  components: RunComponents
}

export type DueMediaCandidate = {
  subjectId: number
  observedAt: string | null
  runId: string | null
  nextRetryAt: string | null
}

export type MediaResultInput = {
  subjectId: number
  detail: MediaDetail | null
  metadata: MediaMetadata | null
  imageRefs: MediaImageRefs | null
  detailHash: string | null
  metadataHash: string | null
  imageHash: string | null
  status: MediaStatus
  observedAt: string
  runId: string
  nextRetryAt: string | null
  deletedAt: string | null
  lastSuccessAt: string | null
}

export type PendingPublicationInput = {
  generation: number
  contentHash: string
  objectKey: string
  runId: string
  createdAt: string
}

export type PublicationClaimInput = {
  generation: number
  contentHash: string
  objectKey: string
  runId: string
  claimedAt: string
}

export type UnclaimedPendingCleanupInput = {
  verifiedGeneration: number
  verifiedContentHash: string | null
}

export type PublicationVerificationInput = {
  generation: number
  contentHash: string
  objectKey: string
  runId: string
  claimedAt: string
  verifiedAt: string
}

export type PublicationState = {
  verifiedGeneration: number
  verifiedContentHash: string | null
  verifiedObjectKey: string | null
  verifiedAt: string | null
  verifiedRunId: string | null
  pendingGeneration: number | null
  pendingContentHash: string | null
  pendingObjectKey: string | null
  pendingRunId: string | null
  pendingClaimedAt: string | null
  pendingCreatedAt: string | null
}

type PublicationRow = QueryResultRow & {
  verified_generation: string | number
  verified_content_hash: string | null
  verified_object_key: string | null
  verified_at: Date | string | null
  verified_run_id: string | null
  pending_generation: string | number | null
  pending_content_hash: string | null
  pending_object_key: string | null
  pending_run_id: string | null
  pending_claimed_at: Date | string | null
  pending_created_at: Date | string | null
}

type MediaCandidateRow = QueryResultRow & {
  subject_id: string | number
  observed_at: Date | string | null
  observed_run_id: string | null
  next_retry_at: Date | string | null
}

type CurrentSubjectRow = QueryResultRow & {
  id: string | number
  content_hash: string
  deleted_at: Date | string | null
}

type CurrentCollectionRow = QueryResultRow & {
  user_id: string
  subject_id: string | number
  payload: CollectionPayload
  content_hash: string
  upstream_updated_at: Date | string | null
  observed_at: Date | string
  missing_since: Date | string | null
  deleted_at: Date | string | null
}

type QueryExecutor = {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

export type PostgresAuthorityOptions = { forbiddenValues: readonly string[] }

const sensitiveFieldName = /^(?:access[_-]?token|refresh[_-]?token|authorization|database[_-]?url|webhook(?:[_-]?(?:url|secret))?|r2[_-]?(?:access[_-]?key|secret[_-]?access[_-]?key))$/i
const rawPersistenceFieldName = /^(?:raw[_-]?(?:error|response|body)|response(?:[_-]?body)?|headers?|stack|cause|message)$/i

export class PostgresAuthority {
  private readonly forbiddenValues: readonly string[]

  constructor(private readonly pool: Pool, options: PostgresAuthorityOptions) {
    if (!options || options.forbiddenValues.length === 0
      || options.forbiddenValues.some((value) => value.length === 0)) {
      throw new Error('PERSISTENCE_SECRETS_REQUIRED')
    }
    this.forbiddenValues = [...options.forbiddenValues]
  }

  async beginRun(input: RunStartInput): Promise<void> {
    assertRunStartInput(input)
    await this.query(this.pool,
      `INSERT INTO sync_runs (id, source, mode, stage, status, started_at, heartbeat_at, git_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.id, input.source, input.mode, input.stage, input.status, input.startedAt, input.heartbeatAt, input.gitSha],
    )
  }

  async heartbeat(id: string, stage: string, at: string): Promise<void> {
    assertRunStartInput({ id, stage, startedAt: at, heartbeatAt: at, source: 'manual', mode: 'shadow', status: 'running', gitSha: '' })
    await this.query(this.pool,
      "UPDATE sync_runs SET stage = $2, heartbeat_at = $3 WHERE id = $1 AND status = 'running'",
      [id, stage, at],
    )
  }

  businessLock(): { acquire(): Promise<boolean>; release(): Promise<void> } {
    let client: PoolClient | undefined
    const key = '-7021825048668725931'
    return {
      acquire: async () => {
        if (client) throw new Error('BUSINESS_LOCK_ALREADY_ACQUIRED')
        const connection = await this.pool.connect()
        try {
          const result = await connection.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [key])
          if (!result.rows[0]?.acquired) { connection.release(); return false }
          client = connection
          return true
        } catch (error) { connection.release(true); throw error }
      },
      release: async () => {
        const connection = client
        client = undefined
        if (!connection) return
        let broken = false
        try { await connection.query('SELECT pg_advisory_unlock($1)', [key]) }
        catch (error) { broken = true; throw error }
        finally { connection.release(broken) }
      },
    }
  }

  async mediaCandidates(input: { now: string; limit: number }): Promise<MediaCandidate[]> {
    if (!Number.isFinite(Date.parse(input.now)) || !Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error('INVALID_MEDIA_SELECTION')
    const result = await this.query<QueryResultRow & MediaCandidate>(this.pool,
      `SELECT s.id AS "subjectId", CASE
         WHEN m.detail IS NULL OR s.last_observed_at > m.observed_at THEN 'new_or_changed'
         WHEN m.status->>'detail' = 'failed' OR m.status->>'image' = 'failed' THEN 'retry'
         WHEN EXISTS (SELECT 1 FROM collection_items c WHERE c.subject_id = s.id AND c.deleted_at IS NULL
           AND COALESCE(c.payload->>'collection_type', c.payload->>'type', '0') <> '2')
           OR EXISTS (SELECT 1 FROM calendar_entries e WHERE e.subject_id = s.id) THEN 'hot'
         ELSE 'cold' END AS priority
       FROM subjects s LEFT JOIN subject_media m ON m.subject_id = s.id
       WHERE s.deleted_at IS NULL AND (m.next_retry_at IS NULL OR m.next_retry_at <= $1)
       ORDER BY CASE WHEN m.detail IS NULL THEN 0 ELSE 1 END, COALESCE(m.next_retry_at, s.first_observed_at), s.id LIMIT $2`,
      [input.now, input.limit])
    return result.rows.map((row) => ({ subjectId: Number(row.subjectId), priority: row.priority }))
  }

  /** Holds one session across fenced reads, object PUTs and reference saves. */
  async withSubject<T>(subjectId: number, work: (session: SubjectSession) => Promise<T>): Promise<T | undefined> {
    if (!Number.isSafeInteger(subjectId) || subjectId < 1) throw new Error('INVALID_SUBJECT_ID')
    const client = await this.pool.connect()
    let broken = false
    try {
      const lock = await withSessionLock(client, BigInt(subjectId), async () => {
        const rows = await this.query<QueryResultRow & MediaResultInput>(client,
          `SELECT subject_id AS "subjectId", detail, metadata, image_refs AS "imageRefs",
             detail_hash AS "detailHash", metadata_hash AS "metadataHash", image_hash AS "imageHash",
             status, observed_at AS "observedAt", observed_run_id AS "runId",
             next_retry_at AS "nextRetryAt", deleted_at AS "deletedAt", last_success_at AS "lastSuccessAt"
           FROM subject_media WHERE subject_id = $1`, [subjectId])
        const row = rows.rows[0]
        const current = row ? { ...row, subjectId: Number(row.subjectId),
          observedAt: toIso(row.observedAt)!, nextRetryAt: toIso(row.nextRetryAt),
          deletedAt: toIso(row.deletedAt), lastSuccessAt: toIso(row.lastSuccessAt) } : null
        let active = true
        try {
          return await work({ current, save: async (input) => {
            if (!active) throw new Error('SUBJECT_SESSION_CLOSED')
            if (input.subjectId !== subjectId) throw new Error('SUBJECT_SESSION_MISMATCH')
            return this.saveMediaResult(client, input)
          } })
        } finally { active = false }
      })
      return lock.value
    } catch (error) { broken = true; throw error }
    finally { client.release(broken) }
  }

  async commitCompleteState(input: CompleteStateInput): Promise<void> {
    assertCompleteStateInput(input)
    await this.transaction(async (client) => {
      for (const user of input.users) {
        await this.query(client,
          `INSERT INTO users (id, upstream_user_id, created_at, updated_at)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (id) DO UPDATE SET upstream_user_id = EXCLUDED.upstream_user_id,
             updated_at = EXCLUDED.updated_at
           WHERE users.upstream_user_id IS DISTINCT FROM EXCLUDED.upstream_user_id`,
          [user.id, user.upstreamUserId, input.observedAt],
        )
      }

      const subjects = collectIncomingSubjects(input)
      const subjectIds = [...subjects.keys()]
      const currentSubjects = new Map<number, CurrentSubjectRow>()
      if (subjectIds.length > 0) {
        const result = await this.query<CurrentSubjectRow>(client,
          `SELECT id, content_hash, deleted_at FROM subjects
           WHERE id = ANY($1::bigint[])`,
          [subjectIds.map(String)],
        )
        for (const row of result.rows) currentSubjects.set(Number(row.id), row)
      }
      for (const subject of subjects.values()) {
        const current = currentSubjects.get(subject.id)
        if (!current || current.content_hash !== subject.contentHash || current.deleted_at !== null) {
          await this.upsertSubject(client, subject, input.observedAt)
        }
      }

      const observedAt = parseTimestamp(input.observedAt, 'observedAt')
      for (const user of input.users) {
        const currentResult = await this.query<CurrentCollectionRow>(client,
          `SELECT user_id, subject_id, payload, content_hash, upstream_updated_at,
             observed_at, missing_since, deleted_at
           FROM collection_items
           WHERE user_id = $1
           ORDER BY subject_id
           FOR UPDATE`,
          [user.id],
        )
        const plan = await planCollectionDiff({
          current: currentResult.rows.map(toPlannerRow),
          incoming: user.items.map((item) => toPlannerCollection(user.id, item)),
          complete: true,
          observedAt,
        })
        for (const row of plan.inserts) {
          const item = requiredCollectionInput(user.items, row.subject_id)
          await this.insertCollection(client, user.id, item, input.observedAt)
        }
        for (const row of [...plan.updates, ...plan.restored]) {
          const item = requiredCollectionInput(user.items, row.subject_id)
          await this.updateCollection(client, user.id, item, input.observedAt)
        }
        for (const row of plan.firstMissing) {
          await this.query(client,
            `UPDATE collection_items SET missing_since = $3, missing_run_id = $4
             WHERE user_id = $1 AND subject_id = $2
               AND missing_since IS NULL AND deleted_at IS NULL`,
            [user.id, row.subject_id, toIsoTimestamp(row.missing_since), input.runId],
          )
        }
        for (const row of plan.confirmedDeleted) {
          await this.query(client,
            `UPDATE collection_items SET deleted_at = $3
             WHERE user_id = $1 AND subject_id = $2
               AND missing_since < $3 AND deleted_at IS NULL`,
            [user.id, row.subject_id, toIsoTimestamp(row.deleted_at)],
          )
        }
      }

      await this.query(client, 'DELETE FROM calendar_entries')
      for (const entry of input.calendarEntries) {
        await this.query(client,
          `INSERT INTO calendar_entries (weekday_id, subject_id, payload, observed_at)
           VALUES ($1, $2, $3, $4)`,
          [entry.weekdayId, entry.subjectId, entry.payload, input.observedAt],
        )
      }
      await this.query(client,
        'UPDATE sync_runs SET stage = $2, heartbeat_at = $3 WHERE id = $1',
        [input.runId, 'complete_state_committed', input.observedAt],
      )
    })
  }

  async listDueMedia(input: { now: string; limit: number }): Promise<DueMediaCandidate[]> {
    const result = await this.query<MediaCandidateRow>(this.pool,
      `SELECT s.id AS subject_id, m.observed_at, m.observed_run_id, m.next_retry_at
       FROM subjects s LEFT JOIN subject_media m ON m.subject_id = s.id
       WHERE s.deleted_at IS NULL AND (m.subject_id IS NULL OR m.next_retry_at IS NULL OR m.next_retry_at <= $1)
       ORDER BY COALESCE(m.next_retry_at, s.first_observed_at), s.id LIMIT $2`,
      [input.now, input.limit],
    )
    return result.rows.map((row) => ({
      subjectId: Number(row.subject_id), observedAt: toIso(row.observed_at), runId: row.observed_run_id,
      nextRetryAt: toIso(row.next_retry_at),
    }))
  }

  async applyMediaResult(input: MediaResultInput): Promise<boolean> {
    return this.saveMediaResult(this.pool, input)
  }

  private async saveMediaResult(executor: QueryExecutor, input: MediaResultInput): Promise<boolean> {
    assertMediaResultInput(input)
    const result = await this.query<{ subject_id: string | number }>(executor,
      `INSERT INTO subject_media (
        subject_id, detail, metadata, image_refs, detail_hash, metadata_hash, image_hash,
        status, observed_at, observed_run_id, next_retry_at, deleted_at, last_success_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (subject_id) DO UPDATE SET
        detail = COALESCE(EXCLUDED.detail, subject_media.detail),
        metadata = COALESCE(EXCLUDED.metadata, subject_media.metadata),
        image_refs = COALESCE(EXCLUDED.image_refs, subject_media.image_refs),
        detail_hash = COALESCE(EXCLUDED.detail_hash, subject_media.detail_hash),
        metadata_hash = COALESCE(EXCLUDED.metadata_hash, subject_media.metadata_hash),
        image_hash = COALESCE(EXCLUDED.image_hash, subject_media.image_hash),
        status = EXCLUDED.status, observed_at = EXCLUDED.observed_at,
        observed_run_id = EXCLUDED.observed_run_id, next_retry_at = EXCLUDED.next_retry_at,
        deleted_at = EXCLUDED.deleted_at,
        last_success_at = COALESCE(EXCLUDED.last_success_at, subject_media.last_success_at)
      WHERE subject_media.observed_at IS NULL
         OR subject_media.observed_at < EXCLUDED.observed_at
         OR (subject_media.observed_at = EXCLUDED.observed_at
             AND subject_media.observed_run_id = EXCLUDED.observed_run_id)
      RETURNING subject_id`,
      [input.subjectId, input.detail, input.metadata, input.imageRefs, input.detailHash, input.metadataHash,
        input.imageHash, input.status, input.observedAt, input.runId, input.nextRetryAt, input.deletedAt, input.lastSuccessAt],
    )
    return (result.rowCount ?? 0) > 0
  }

  async getPublicationState(): Promise<PublicationState> {
    const result = await this.query<PublicationRow>(this.pool, 'SELECT * FROM publications WHERE id = true')
    return parsePublicationRow(requiredRow(result.rows[0], 'PUBLICATION_STATE_MISSING'))
  }

  async savePendingPublication(input: PendingPublicationInput): Promise<PublicationState> {
    assertPendingPublicationInput(input)
    return this.transaction(async (client) => {
      const result = await this.query<PublicationRow>(client, 'SELECT * FROM publications WHERE id = true FOR UPDATE')
      const current = parsePublicationRow(requiredRow(result.rows[0], 'PUBLICATION_STATE_MISSING'))
      if (current.pendingGeneration === input.generation
        && current.pendingContentHash === input.contentHash
        && current.pendingObjectKey === input.objectKey
        && current.pendingRunId === input.runId
        && current.pendingCreatedAt === input.createdAt
        && current.pendingClaimedAt === null) return current

      const canReplacePending = current.pendingGeneration === input.generation && current.pendingClaimedAt === null
      if (input.generation !== current.verifiedGeneration + 1
        || (current.pendingGeneration !== null && !canReplacePending)) {
        throw new Error('PUBLICATION_GENERATION_CONFLICT')
      }
      const update = await this.query<PublicationRow>(client,
        `UPDATE publications SET pending_generation = $1, pending_content_hash = $2,
          pending_object_key = $3, pending_run_id = $4, pending_claimed_at = $5,
          pending_created_at = $6 WHERE id = true RETURNING *`,
        [input.generation, input.contentHash, input.objectKey, input.runId, null, input.createdAt],
      )
      return parsePublicationRow(requiredRow(update.rows[0], 'PUBLICATION_STATE_MISSING'))
    })
  }

  async claimPendingPublication(input: PublicationClaimInput): Promise<PublicationState> {
    assertPublicationClaimInput(input)
    const result = await this.query<PublicationRow>(this.pool,
      `UPDATE publications SET pending_claimed_at = $5
       WHERE id = true AND pending_generation = $1 AND pending_content_hash = $2
         AND pending_object_key = $3 AND pending_run_id = $4
         AND pending_claimed_at IS NULL
         AND pending_generation = verified_generation + 1
       RETURNING *`,
      [input.generation, input.contentHash, input.objectKey, input.runId, input.claimedAt],
    )
    if ((result.rowCount ?? 0) === 1) {
      return parsePublicationRow(requiredRow(result.rows[0], 'PUBLICATION_STATE_MISSING'))
    }
    const current = await this.getPublicationState()
    if (current.pendingGeneration === input.generation
      && current.pendingContentHash === input.contentHash
      && current.pendingObjectKey === input.objectKey
      && current.pendingRunId === input.runId
      && current.pendingClaimedAt === input.claimedAt
      && current.pendingGeneration === current.verifiedGeneration + 1) return current
    throw new Error('PUBLICATION_GENERATION_CONFLICT')
  }

  async clearUnclaimedPending(input: UnclaimedPendingCleanupInput): Promise<PublicationState> {
    assertUnclaimedPendingCleanupInput(input)
    const result = await this.query<PublicationRow>(this.pool,
      `UPDATE publications SET pending_generation = NULL, pending_content_hash = NULL,
         pending_object_key = NULL, pending_run_id = NULL, pending_claimed_at = NULL,
         pending_created_at = NULL
       WHERE id = true AND verified_generation = $1
         AND verified_content_hash IS NOT DISTINCT FROM $2
         AND pending_generation IS NOT NULL AND pending_claimed_at IS NULL
       RETURNING *`,
      [input.verifiedGeneration, input.verifiedContentHash],
    )
    if ((result.rowCount ?? 0) === 1) {
      return parsePublicationRow(requiredRow(result.rows[0], 'PUBLICATION_STATE_MISSING'))
    }
    const current = await this.getPublicationState()
    if (current.verifiedGeneration !== input.verifiedGeneration
      || current.verifiedContentHash !== input.verifiedContentHash) {
      throw new Error('PUBLICATION_GENERATION_CONFLICT')
    }
    return current
  }

  async verifyPublication(input: PublicationVerificationInput): Promise<PublicationState> {
    assertPublicationVerificationInput(input)
    const result = await this.query<PublicationRow>(this.pool,
      `UPDATE publications SET verified_generation = $1, verified_content_hash = $2,
        verified_object_key = $3, verified_at = $6, verified_run_id = pending_run_id,
        pending_generation = NULL, pending_content_hash = NULL, pending_object_key = NULL,
        pending_run_id = NULL, pending_claimed_at = NULL, pending_created_at = NULL
       WHERE id = true AND pending_generation = $1 AND pending_content_hash = $2
         AND pending_object_key = $3 AND pending_run_id = $4
         AND pending_claimed_at = $5 AND pending_claimed_at IS NOT NULL
         AND pending_generation = verified_generation + 1
       RETURNING *`,
      [input.generation, input.contentHash, input.objectKey, input.runId, input.claimedAt, input.verifiedAt],
    )
    if ((result.rowCount ?? 0) !== 1) throw new Error('PUBLICATION_GENERATION_CONFLICT')
    return parsePublicationRow(requiredRow(result.rows[0], 'PUBLICATION_STATE_MISSING'))
  }

  async finishRun(input: RunFinishInput): Promise<void> {
    assertRunFinishInput(input)
    const sanitizedError = input.sanitizedError === null ? null : {
      category: input.sanitizedError.category, code: input.sanitizedError.code,
      attemptCount: input.sanitizedError.attemptCount, stage: input.sanitizedError.stage,
    }
    await this.query(this.pool,
      `UPDATE sync_runs SET stage = $2, status = $3, heartbeat_at = $4, finished_at = $5,
        counts = $6, stage_durations = $7, sanitized_error = $8, components = $9 WHERE id = $1`,
      [input.id, input.stage, input.status, input.heartbeatAt, input.finishedAt,
        input.counts, input.stageDurations, sanitizedError, input.components],
    )
  }

  private async insertCollection(
    client: PoolClient,
    userId: string,
    item: { subject: SubjectInput; collection: CollectionInput },
    observedAt: string,
  ): Promise<void> {
    await this.query(client,
      `INSERT INTO collection_items (
        user_id, subject_id, payload, content_hash, upstream_updated_at,
        missing_since, missing_run_id, deleted_at, observed_at
      ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, $6)`,
      [userId, item.subject.id, item.collection.payload, item.collection.contentHash,
        item.collection.upstreamUpdatedAt, observedAt],
    )
  }

  private async updateCollection(
    client: PoolClient,
    userId: string,
    item: { subject: SubjectInput; collection: CollectionInput },
    observedAt: string,
  ): Promise<void> {
    await this.query(client,
      `UPDATE collection_items SET payload = $3, content_hash = $4,
         upstream_updated_at = $5, missing_since = NULL, missing_run_id = NULL,
         deleted_at = NULL, observed_at = $6
       WHERE user_id = $1 AND subject_id = $2`,
      [userId, item.subject.id, item.collection.payload, item.collection.contentHash,
        item.collection.upstreamUpdatedAt, observedAt],
    )
  }

  private async upsertSubject(client: PoolClient, subject: SubjectInput, observedAt: string): Promise<void> {
    await this.query(client,
      `INSERT INTO subjects (
        id, subject_type, payload, content_hash, upstream_updated_at,
        first_observed_at, last_observed_at, deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $6, NULL)
      ON CONFLICT (id) DO UPDATE SET subject_type = EXCLUDED.subject_type,
        payload = EXCLUDED.payload, content_hash = EXCLUDED.content_hash,
        upstream_updated_at = EXCLUDED.upstream_updated_at,
        last_observed_at = EXCLUDED.last_observed_at, deleted_at = NULL
      WHERE subjects.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         OR subjects.deleted_at IS NOT NULL`,
      [subject.id, subject.subjectType, subject.payload, subject.contentHash, subject.upstreamUpdatedAt, observedAt],
    )
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let began = false
    try {
      await this.query(client, 'BEGIN')
      began = true
      const value = await work(client)
      await this.query(client, 'COMMIT')
      return value
    } catch (error) {
      if (began) {
        try {
          await this.query(client, 'ROLLBACK')
        } catch {
          // Preserve the primary work/commit error; releasing closes a broken session.
        }
      }
      throw error
    } finally {
      client.release()
    }
  }

  private async query<Row extends QueryResultRow = QueryResultRow>(
    executor: QueryExecutor,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    assertSafePersistence(values, this.forbiddenValues)
    return executor.query<Row>(sql, [...values])
  }
}

function collectIncomingSubjects(input: CompleteStateInput): Map<number, SubjectInput> {
  const subjects = new Map<number, SubjectInput>()
  const add = (subject: SubjectInput): void => {
    const existing = subjects.get(subject.id)
    if (existing && existing.contentHash !== subject.contentHash) {
      throw new Error(`CONFLICTING_SUBJECT_PROJECTION: ${subject.id}`)
    }
    subjects.set(subject.id, subject)
  }
  for (const user of input.users) {
    for (const item of user.items) add(item.subject)
  }
  for (const entry of input.calendarEntries) {
    if (entry.subjectId !== entry.subject.id) throw new Error('CALENDAR_SUBJECT_ID_MISMATCH')
    add(entry.subject)
  }
  return subjects
}

function toPlannerRow(row: CurrentCollectionRow): NormalizedCollection['row'] {
  const observedAt = parseTimestamp(row.observed_at, 'collection.observed_at')
  return {
    user_id: row.user_id,
    subject_id: Number(row.subject_id),
    collection_type: row.payload.collection_type ?? row.payload.type ?? 0,
    rate: row.payload.rate ?? null,
    tags_json: JSON.stringify(row.payload.tags ?? []),
    comment: row.payload.comment ?? '',
    ep_status: row.payload.ep_status ?? 0,
    vol_status: row.payload.vol_status ?? 0,
    upstream_updated_at: toIso(row.upstream_updated_at),
    subject_json: '{}',
    content_hash: row.content_hash,
    state_version: 1,
    temperature: (row.payload.collection_type ?? row.payload.type) === 2 ? 'cold' : 'hot',
    first_seen_at: observedAt,
    changed_at: observedAt,
    missing_since: parseNullableTimestamp(row.missing_since, 'collection.missing_since'),
    deleted_at: parseNullableTimestamp(row.deleted_at, 'collection.deleted_at'),
  }
}

function toPlannerCollection(
  userId: string,
  item: { subject: SubjectInput; collection: CollectionInput },
): NormalizedCollection {
  const subject = item.subject.payload
  const collection = item.collection.payload
  const collectionType = collection.collection_type ?? collection.type ?? 0
  const rating = subject.rating
  return {
    row: {
      user_id: userId,
      subject_id: item.subject.id,
      collection_type: collectionType,
      rate: collection.rate ?? null,
      tags_json: JSON.stringify(collection.tags ?? []),
      comment: collection.comment ?? '',
      ep_status: collection.ep_status ?? 0,
      vol_status: collection.vol_status ?? 0,
      upstream_updated_at: item.collection.upstreamUpdatedAt,
      subject_json: JSON.stringify(subject),
      content_hash: item.collection.contentHash,
      state_version: 1,
      temperature: collectionType === 2 ? 'cold' : 'hot',
      first_seen_at: 0,
      changed_at: 0,
      missing_since: null,
      deleted_at: null,
    },
    public_item: {
      subject_id: item.subject.id,
      name: subject.name,
      name_cn: subject.name_cn ?? '',
      summary: subject.summary ?? '',
      images: { common: null, large: null },
      image_status: { common: 'pending_next_cron', large: 'pending_next_cron' },
      eps: subject.eps ?? 0,
      total_episodes: subject.total_episodes ?? 0,
      ep_status: collection.ep_status ?? 0,
      vol_status: collection.vol_status ?? 0,
      type: item.subject.subjectType,
      collection_type: collectionType,
      rate: collection.rate ?? 0,
      nsfw: subject.nsfw ?? false,
      date: subject.date ?? '',
      tags: [...(collection.tags ?? [])],
      updated_at: item.collection.upstreamUpdatedAt ?? '',
      ...(rating ? { rating } : {}),
    },
  }
}

function requiredCollectionInput(
  items: CompleteStateInput['users'][number]['items'],
  subjectId: number,
): { subject: SubjectInput; collection: CollectionInput } {
  const item = items.find((candidate) => candidate.subject.id === subjectId)
  if (!item) throw new Error(`COLLECTION_PLAN_INPUT_MISSING: ${subjectId}`)
  return item
}

function parseTimestamp(value: Date | string, path: string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`INVALID_PERSISTENCE_TIMESTAMP: ${path}`)
  return timestamp
}

function parseNullableTimestamp(value: Date | string | null, path: string): number | null {
  return value === null ? null : parseTimestamp(value, path)
}

function toIsoTimestamp(value: number | null): string {
  if (value === null) throw new Error('COLLECTION_PLAN_TIMESTAMP_MISSING')
  return new Date(value).toISOString()
}

function parsePublicationRow(row: PublicationRow): PublicationState {
  return {
    verifiedGeneration: Number(row.verified_generation), verifiedContentHash: row.verified_content_hash,
    verifiedObjectKey: row.verified_object_key, verifiedAt: toIso(row.verified_at), verifiedRunId: row.verified_run_id,
    pendingGeneration: row.pending_generation === null ? null : Number(row.pending_generation),
    pendingContentHash: row.pending_content_hash, pendingObjectKey: row.pending_object_key,
    pendingRunId: row.pending_run_id, pendingClaimedAt: toIso(row.pending_claimed_at),
    pendingCreatedAt: toIso(row.pending_created_at),
  }
}

function toIso(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value
}

function requiredRow<Row>(row: Row | undefined, code: string): Row {
  if (row === undefined) throw new Error(code)
  return row
}

function assertSafePersistence(values: readonly unknown[], forbiddenValues: readonly string[]): void {
  const inspect = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (forbiddenValues.some((secret) => value.includes(secret))) throw new Error(`FORBIDDEN_PERSISTENCE_VALUE: ${path}`)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${path}[${index}]`))
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveFieldName.test(key)) throw new Error(`FORBIDDEN_PERSISTENCE_FIELD: ${path}.${key}`)
      if (rawPersistenceFieldName.test(key)) throw new Error(`FORBIDDEN_PERSISTENCE_SHAPE: ${path}.${key}`)
      inspect(item, `${path}.${key}`)
    }
  }
  values.forEach((value, index) => inspect(value, `$${index + 1}`))
}
