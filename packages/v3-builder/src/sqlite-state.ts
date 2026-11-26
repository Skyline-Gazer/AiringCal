import { DatabaseSync } from 'node:sqlite'
import type { BuilderJobLease, BuilderStateStore } from '@airing-cal/v3-core'
import type { CollectionRow } from '@airing-cal/storage'

export class SqliteBuilderStateStore implements BuilderStateStore {
  constructor(private readonly db: DatabaseSync) {}

  async acquireLease(
    jobId: string,
    ownerToken: string,
    ttlSeconds: number,
    nowUnix = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    const expiresAt = nowUnix + ttlSeconds
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(
        'SELECT owner_token, expires_at_unix FROM builder_job_leases WHERE job_id = ?',
      ).get(jobId) as { owner_token: string; expires_at_unix: number } | undefined

      if (row && row.expires_at_unix > nowUnix && row.owner_token !== ownerToken) {
        this.db.exec('ROLLBACK')
        return false
      }

      this.db.prepare(
        `INSERT INTO builder_job_leases (job_id, owner_token, expires_at_unix, updated_at_unix)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           owner_token = excluded.owner_token,
           expires_at_unix = excluded.expires_at_unix,
           updated_at_unix = excluded.updated_at_unix`,
      ).run(jobId, ownerToken, expiresAt, nowUnix)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async releaseLease(jobId: string, ownerToken: string): Promise<void> {
    this.db.prepare(
      'DELETE FROM builder_job_leases WHERE job_id = ? AND owner_token = ?',
    ).run(jobId, ownerToken)
  }

  async getLease(jobId: string): Promise<BuilderJobLease | null> {
    const row = this.db.prepare(
      'SELECT job_id, owner_token, expires_at_unix FROM builder_job_leases WHERE job_id = ?',
    ).get(jobId) as { job_id: string; owner_token: string; expires_at_unix: number } | undefined
    if (!row) return null
    return {
      job_id: row.job_id,
      owner_token: row.owner_token,
      expires_at_unix: row.expires_at_unix,
    }
  }

  async setKv(key: string, valueJson: string, nowUnix = Math.floor(Date.now() / 1000)): Promise<void> {
    this.db.prepare(
      `INSERT INTO builder_kv (key, value_json, updated_at_unix)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_unix = excluded.updated_at_unix`,
    ).run(key, valueJson, nowUnix)
  }

  async getKv(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value_json FROM builder_kv WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined
    return row?.value_json ?? null
  }

  /** #195: read the collection reconciliation ledger (internal checkpoint state). */
  listCollectionRows(): CollectionRow[] {
    const rows = this.db.prepare('SELECT * FROM v3_collections').all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      user_id: String(row.user_id),
      subject_id: Number(row.subject_id),
      collection_type: Number(row.collection_type),
      rate: row.rate === null ? null : Number(row.rate),
      tags_json: String(row.tags_json),
      comment: String(row.comment ?? ''),
      ep_status: Number(row.ep_status),
      vol_status: Number(row.vol_status),
      upstream_updated_at: row.upstream_updated_at === null ? null : String(row.upstream_updated_at),
      subject_json: String(row.subject_json),
      content_hash: String(row.content_hash),
      state_version: Number(row.state_version),
      temperature: String(row.temperature) as 'hot' | 'cold',
      first_seen_at: Number(row.first_seen_at),
      changed_at: Number(row.changed_at),
      missing_since: row.missing_since === null ? null : Number(row.missing_since),
      deleted_at: row.deleted_at === null ? null : Number(row.deleted_at),
    }))
  }

  /**
   * #195: atomically persist the internal checkpoint state (collection ledger
   * rows + per-episode progress) and, when a new public generation was
   * produced, the snapshot itself. All-or-nothing: a crash mid-write leaves
   * the previous checkpoint (and therefore the last valid release) intact.
   */
  persistCheckpointState({
    collectionRows,
    episodeProgress,
    prunedSubjects,
    snapshotJson,
    observedAt,
  }: {
    collectionRows: CollectionRow[]
    episodeProgress: Array<{
      user_id: string
      subject_id: number
      observed_at: number
      episodes: Array<{
        episode_id: number
        collection_type: number
        episode_type?: number
        sort?: number
        ep?: number
        airdate?: string
        updated_at: number
      }>
    }>
    /** Subjects whose collections were confirmed deleted: drop their episode rows. */
    prunedSubjects: Array<{ user_id: string; subject_id: number }>
    snapshotJson: string | null
    observedAt: number
  }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const upsertCollection = this.db.prepare(
        `INSERT INTO v3_collections (
          user_id, subject_id, collection_type, rate, tags_json, comment, ep_status, vol_status,
          upstream_updated_at, subject_json, content_hash, state_version, temperature,
          first_seen_at, changed_at, missing_since, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, subject_id) DO UPDATE SET
          collection_type = excluded.collection_type,
          rate = excluded.rate,
          tags_json = excluded.tags_json,
          comment = excluded.comment,
          ep_status = excluded.ep_status,
          vol_status = excluded.vol_status,
          upstream_updated_at = excluded.upstream_updated_at,
          subject_json = excluded.subject_json,
          content_hash = excluded.content_hash,
          state_version = excluded.state_version,
          temperature = excluded.temperature,
          first_seen_at = excluded.first_seen_at,
          changed_at = excluded.changed_at,
          missing_since = excluded.missing_since,
          deleted_at = excluded.deleted_at`,
      )
      for (const row of collectionRows) {
        upsertCollection.run(
          row.user_id,
          row.subject_id,
          row.collection_type,
          row.rate,
          row.tags_json,
          row.comment,
          row.ep_status,
          row.vol_status,
          row.upstream_updated_at,
          row.subject_json,
          row.content_hash,
          row.state_version,
          row.temperature,
          row.first_seen_at,
          row.changed_at,
          row.missing_since,
          row.deleted_at,
        )
      }
      const deleteEpisodes = this.db.prepare(
        'DELETE FROM v3_episode_progress WHERE user_id = ? AND subject_id = ?',
      )
      const insertEpisode = this.db.prepare(
        `INSERT INTO v3_episode_progress (
          user_id, subject_id, episode_id, collection_type, episode_type, sort, ep, airdate, updated_at, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const subject of episodeProgress) {
        deleteEpisodes.run(subject.user_id, subject.subject_id)
        for (const episode of subject.episodes) {
          insertEpisode.run(
            subject.user_id,
            subject.subject_id,
            episode.episode_id,
            episode.collection_type,
            episode.episode_type ?? null,
            episode.sort ?? null,
            episode.ep ?? null,
            episode.airdate ?? null,
            episode.updated_at,
            subject.observed_at,
          )
        }
      }
      for (const pruned of prunedSubjects) deleteEpisodes.run(pruned.user_id, pruned.subject_id)
      if (snapshotJson !== null) {
        this.db.prepare(
          `INSERT INTO builder_kv (key, value_json, updated_at_unix)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_unix = excluded.updated_at_unix`,
        ).run('checkpoint:public-snapshot', snapshotJson, observedAt)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
