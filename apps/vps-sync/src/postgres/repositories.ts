import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

type JsonObject = Readonly<Record<string, unknown>>

export type SubjectInput = {
  id: number
  subjectType: number
  payload: JsonObject
  contentHash: string
  upstreamUpdatedAt: string | null
}

export type CollectionInput = {
  payload: JsonObject
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
  calendarEntries: readonly { weekdayId: number; subjectId: number; payload: JsonObject }[]
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
  counts: JsonObject
  stageDurations: JsonObject
  sanitizedError: SanitizedError | null
  components: JsonObject
}

export type DueMediaCandidate = {
  subjectId: number
  observedAt: string | null
  runId: string | null
  nextRetryAt: string | null
}

export type MediaResultInput = {
  subjectId: number
  detail: JsonObject | null
  metadata: JsonObject | null
  imageRefs: JsonObject | null
  detailHash: string | null
  metadataHash: string | null
  imageHash: string | null
  status: JsonObject
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
  claimedAt: string | null
  createdAt: string
}

export type PublicationVerificationInput = {
  generation: number
  contentHash: string
  objectKey: string
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

type QueryExecutor = {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

export type PostgresAuthorityOptions = { forbiddenValues?: readonly string[] }

const sensitiveFieldName = /^(?:access[_-]?token|refresh[_-]?token|authorization|database[_-]?url|webhook(?:[_-]?(?:url|secret))?|r2[_-]?(?:access[_-]?key|secret[_-]?access[_-]?key))$/i

export class PostgresAuthority {
  private readonly forbiddenValues: readonly string[]

  constructor(private readonly pool: Pool, options: PostgresAuthorityOptions = {}) {
    this.forbiddenValues = (options.forbiddenValues ?? []).filter((value) => value.length > 0)
  }

  async beginRun(input: RunStartInput): Promise<void> {
    await this.query(this.pool,
      `INSERT INTO sync_runs (id, source, mode, stage, status, started_at, heartbeat_at, git_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.id, input.source, input.mode, input.stage, input.status, input.startedAt, input.heartbeatAt, input.gitSha],
    )
  }

  async commitCompleteState(input: CompleteStateInput): Promise<void> {
    await this.transaction(async (client) => {
      for (const user of input.users) {
        await this.query(client,
          `INSERT INTO users (id, upstream_user_id, created_at, updated_at)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (id) DO UPDATE SET upstream_user_id = EXCLUDED.upstream_user_id, updated_at = EXCLUDED.updated_at`,
          [user.id, user.upstreamUserId, input.observedAt],
        )
        for (const item of user.items) {
          await this.upsertSubject(client, item.subject, input.observedAt)
          await this.query(client,
            `INSERT INTO collection_items (
              user_id, subject_id, payload, content_hash, upstream_updated_at,
              missing_since, missing_run_id, deleted_at, observed_at
            ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, $6)
            ON CONFLICT (user_id, subject_id) DO UPDATE SET
              payload = EXCLUDED.payload, content_hash = EXCLUDED.content_hash,
              upstream_updated_at = EXCLUDED.upstream_updated_at,
              missing_since = NULL, missing_run_id = NULL, deleted_at = NULL,
              observed_at = EXCLUDED.observed_at`,
            [user.id, item.subject.id, item.collection.payload, item.collection.contentHash, item.collection.upstreamUpdatedAt, input.observedAt],
          )
        }
        await this.query(client,
          `UPDATE collection_items
           SET deleted_at = CASE WHEN missing_since IS NOT NULL AND missing_run_id <> $2 THEN $3 ELSE deleted_at END,
               missing_since = COALESCE(missing_since, $3),
               missing_run_id = COALESCE(missing_run_id, $2)
           WHERE user_id = $1 AND NOT (subject_id = ANY($4::bigint[])) AND deleted_at IS NULL`,
          [user.id, input.runId, input.observedAt, user.items.map((item) => String(item.subject.id))],
        )
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
    const result = await this.query<{ subject_id: string | number }>(this.pool,
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
    return this.transaction(async (client) => {
      const result = await this.query<PublicationRow>(client, 'SELECT * FROM publications WHERE id = true FOR UPDATE')
      const current = parsePublicationRow(requiredRow(result.rows[0], 'PUBLICATION_STATE_MISSING'))
      if (current.pendingGeneration === input.generation
        && current.pendingContentHash === input.contentHash
        && current.pendingObjectKey === input.objectKey) return current

      const canReplacePending = current.pendingGeneration === input.generation && current.pendingClaimedAt === null
      if (input.generation !== current.verifiedGeneration + 1
        || (current.pendingGeneration !== null && !canReplacePending)) {
        throw new Error('PUBLICATION_GENERATION_CONFLICT')
      }
      const update = await this.query<PublicationRow>(client,
        `UPDATE publications SET pending_generation = $1, pending_content_hash = $2,
          pending_object_key = $3, pending_run_id = $4, pending_claimed_at = $5,
          pending_created_at = $6 WHERE id = true RETURNING *`,
        [input.generation, input.contentHash, input.objectKey, input.runId, input.claimedAt, input.createdAt],
      )
      return parsePublicationRow(requiredRow(update.rows[0], 'PUBLICATION_STATE_MISSING'))
    })
  }

  async verifyPublication(input: PublicationVerificationInput): Promise<PublicationState> {
    const result = await this.query<PublicationRow>(this.pool,
      `UPDATE publications SET verified_generation = $1, verified_content_hash = $2,
        verified_object_key = $3, verified_at = $4, verified_run_id = pending_run_id,
        pending_generation = NULL, pending_content_hash = NULL, pending_object_key = NULL,
        pending_run_id = NULL, pending_claimed_at = NULL, pending_created_at = NULL
       WHERE id = true AND pending_generation = $1 AND pending_content_hash = $2
         AND pending_object_key = $3 AND pending_generation = verified_generation + 1
       RETURNING *`,
      [input.generation, input.contentHash, input.objectKey, input.verifiedAt],
    )
    if ((result.rowCount ?? 0) !== 1) throw new Error('PUBLICATION_GENERATION_CONFLICT')
    return parsePublicationRow(requiredRow(result.rows[0], 'PUBLICATION_STATE_MISSING'))
  }

  async finishRun(input: RunFinishInput): Promise<void> {
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

  private async upsertSubject(client: PoolClient, subject: SubjectInput, observedAt: string): Promise<void> {
    await this.query(client,
      `INSERT INTO subjects (
        id, subject_type, payload, content_hash, upstream_updated_at,
        first_observed_at, last_observed_at, deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $6, NULL)
      ON CONFLICT (id) DO UPDATE SET subject_type = EXCLUDED.subject_type,
        payload = EXCLUDED.payload, content_hash = EXCLUDED.content_hash,
        upstream_updated_at = EXCLUDED.upstream_updated_at,
        last_observed_at = EXCLUDED.last_observed_at, deleted_at = NULL`,
      [subject.id, subject.subjectType, subject.payload, subject.contentHash, subject.upstreamUpdatedAt, observedAt],
    )
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    await this.query(client, 'BEGIN')
    try {
      const value = await work(client)
      await this.query(client, 'COMMIT')
      return value
    } catch (error) {
      await this.query(client, 'ROLLBACK')
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
      inspect(item, `${path}.${key}`)
    }
  }
  values.forEach((value, index) => inspect(value, `$${index + 1}`))
}
