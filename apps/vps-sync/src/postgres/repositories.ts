import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface Subject {
  subject_id: number;
  type: number;
  name: string;
  name_cn: string;
  summary: string;
  date: string;
  eps: number;
  total_episodes: number;
  nsfw: boolean;
  rating?: { score: number; rank: number; total: number };
  upstream_updated_at?: string | null;
}

export interface CollectionItem {
  subject_id: number;
  collection_type: number;
  rate: number;
  tags: string[];
  comment: string;
  ep_status: number;
  vol_status: number;
  private: boolean;
  upstream_updated_at: string | null;
}

export interface CompleteState {
  run_id: string;
  /** Unix seconds, matching the existing domain observation clock. */
  observed_at: number;
  complete: boolean;
  configured_user_ids: string[];
  users: { user_id: string; upstream_username: string; complete: boolean; items: CollectionItem[] }[];
  subjects: Subject[];
  calendar: { weekday: number; subject_id: number }[];
}

export interface RunStart {
  run_id: string;
  observed_at: number;
  source: "cron" | "manual";
  mode: "shadow" | "live";
  git_sha: string;
}

export interface Publication {
  generation: number;
  content_hash: string;
  object_key: string;
  published_at: number;
  observed_at: number;
  run_id: string;
  item_count: number;
  git_sha: string;
}

export interface PublicationState {
  verified: Publication | null;
  pending: Publication | null;
  claimed: boolean;
}

export interface MediaCandidate { subject_id: number; run_id: string; observed_at: number }
export interface MediaResult extends MediaCandidate {
  status: "ok" | "failed" | "not_found";
  detail?: Subject;
  detail_hash?: string;
  common_key?: string | null;
  common_hash?: string | null;
  large_key?: string | null;
  large_hash?: string | null;
  next_refresh_at?: number;
  next_retry_at?: number;
  tombstone_until?: number;
  error_code?: string;
}

export interface RunFinish {
  status: "success" | "no_change" | "partial" | "failed" | "skipped";
  completed_at: number;
  publication: "not_attempted" | "verified" | "no_change" | "failed";
  backup: "not_attempted" | "success" | "failed";
  notification: "not_attempted" | "success" | "failed";
  error_code?: string;
  media_succeeded?: number;
  media_failed?: number;
  durations?: Partial<Record<"fetch" | "state" | "media" | "publication" | "backup" | "notification", number>>;
}

const ERROR_CODES = new Set(["UNKNOWN", "UPSTREAM_AUTH", "UPSTREAM_NOT_FOUND", "UPSTREAM_RATE_LIMIT", "UPSTREAM_TIMEOUT", "UPSTREAM_NETWORK", "UPSTREAM_SERVER", "UPSTREAM_CONTRACT", "DATABASE", "MEDIA_INVALID", "MEDIA_UPLOAD", "PUBLICATION", "BACKUP", "NOTIFICATION", "LOCK_UNAVAILABLE"]);
const code = (value?: string) => value === undefined ? null : ERROR_CODES.has(value) ? value : "UNKNOWN";
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hashPattern = /^[0-9a-f]{64}$/;
const identityPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function requireValid(valid: boolean, error = "INVALID_COMPLETE_STATE"): asserts valid {
  if (!valid) throw new Error(error);
}

function subjectProjection(value: Subject): Subject {
  requireValid(integer(value.subject_id, 1) && integer(value.type, 1) && value.type <= 6
    && [value.name, value.name_cn, value.summary, value.date].every((field) => typeof field === "string")
    && integer(value.eps) && integer(value.total_episodes) && typeof value.nsfw === "boolean"
    && (value.upstream_updated_at == null || typeof value.upstream_updated_at === "string"));
  const rating = value.rating;
  if (rating !== undefined) requireValid(Number.isFinite(rating.score) && rating.score >= 0 && rating.score <= 10 && integer(rating.rank) && integer(rating.total));
  return {
    subject_id: value.subject_id, type: value.type, name: value.name, name_cn: value.name_cn,
    summary: value.summary, date: value.date, eps: value.eps, total_episodes: value.total_episodes, nsfw: value.nsfw,
    ...(rating === undefined ? {} : { rating: { score: rating.score, rank: rating.rank, total: rating.total } }),
    upstream_updated_at: value.upstream_updated_at ?? null,
  };
}

function collectionProjection(item: CollectionItem): CollectionItem {
  requireValid(integer(item.subject_id, 1) && integer(item.collection_type, 1) && item.collection_type <= 5
    && integer(item.rate) && item.rate <= 10 && Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string")
    && typeof item.comment === "string" && integer(item.ep_status) && integer(item.vol_status) && typeof item.private === "boolean"
    && (item.upstream_updated_at === null || typeof item.upstream_updated_at === "string"));
  return { subject_id: item.subject_id, collection_type: item.collection_type, rate: item.rate, tags: [...item.tags], comment: item.comment, ep_status: item.ep_status, vol_status: item.vol_status, private: item.private, upstream_updated_at: item.upstream_updated_at };
}

function newerOrEqual(a: { observed_at: number; run_id: string }, b: { observed_at: number; run_id: string }): boolean {
  return a.observed_at > b.observed_at || (a.observed_at === b.observed_at && a.run_id >= b.run_id);
}

/** Pool must be constructed using DATABASE_URL; runtime credentials never enter a row. */
export class PostgresAuthority {
  constructor(private readonly pool: Pool, private readonly secrets: readonly string[]) {}

  private safe(value: unknown): void {
    const serialized = JSON.stringify(value);
    requireValid(!this.secrets.some((secret) => secret.length > 0 && serialized.includes(JSON.stringify(secret).slice(1, -1)))
      && !/(?:postgres(?:ql)?:\/\/|Bearer\s|https?:\/\/[^\s"/]+:[^\s"/]+@)/i.test(serialized), "SECRET_PERSISTENCE_FORBIDDEN");
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally { client.release(); }
  }

  private async requireRun(client: PoolClient, run_id: string, observed_at: number): Promise<void> {
    const result = await client.query("SELECT 1 FROM sync_runs WHERE run_id = $1 AND observed_at = $2", [run_id, observed_at]);
    requireValid(result.rowCount === 1, "RUN_CONFLICT");
  }

  async beginRun(input: RunStart): Promise<void> {
    requireValid(identityPattern.test(input.run_id) && integer(input.observed_at) && ["cron", "manual"].includes(input.source)
      && ["shadow", "live"].includes(input.mode) && /^[0-9a-f]{40}$/.test(input.git_sha), "INVALID_RUN");
    this.safe({ run_id: input.run_id, git_sha: input.git_sha });
    const result = await this.pool.query(`INSERT INTO sync_runs (run_id, observed_at, source, mode, git_sha, heartbeat_at)
      VALUES ($1, $2, $3, $4, $5, $2) ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id
      WHERE sync_runs.observed_at = EXCLUDED.observed_at AND sync_runs.source = EXCLUDED.source
        AND sync_runs.mode = EXCLUDED.mode AND sync_runs.git_sha = EXCLUDED.git_sha`,
    [input.run_id, input.observed_at, input.source, input.mode, input.git_sha]);
    requireValid(result.rowCount === 1, "RUN_CONFLICT");
  }

  async commitCompleteState(input: CompleteState): Promise<void> {
    requireValid(input.complete === true && integer(input.observed_at) && input.configured_user_ids.length > 0);
    const configured = new Set(input.configured_user_ids);
    requireValid(configured.size === input.configured_user_ids.length && input.users.length === configured.size);
    const users = input.users.map((user) => {
      requireValid(user.complete === true && configured.delete(user.user_id) && identityPattern.test(user.user_id)
        && typeof user.upstream_username === "string" && user.upstream_username.length > 0);
      const items = user.items.map(collectionProjection);
      requireValid(new Set(items.map((item) => item.subject_id)).size === items.length);
      return { user_id: user.user_id, upstream_username: user.upstream_username, items };
    });
    const subjects = input.subjects.map(subjectProjection);
    const ids = new Set(subjects.map((subject) => subject.subject_id));
    requireValid(ids.size === subjects.length && users.every((user) => user.items.every((item) => ids.has(item.subject_id))));
    const calendar = input.calendar.map(({ weekday, subject_id }) => {
      requireValid(integer(weekday, 1) && weekday <= 7 && ids.has(subject_id));
      return { weekday, subject_id };
    });
    requireValid(new Set(calendar.map((entry) => `${entry.weekday}/${entry.subject_id}`)).size === calendar.length);
    this.safe({ users, subjects, calendar });

    await this.transaction(async (client) => {
      // One complete-state writer; the runtime's session lock also covers external stages.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", ["7262935170"]);
      await this.requireRun(client, input.run_id, input.observed_at);
      const latest = (await client.query("SELECT run_id, observed_at FROM sync_runs WHERE state_committed_at IS NOT NULL ORDER BY observed_at DESC, run_id DESC LIMIT 1")).rows[0];
      if (latest) requireValid(newerOrEqual(input, { run_id: latest.run_id, observed_at: Number(latest.observed_at) }), "STALE_OBSERVATION");
      const run = (await client.query("SELECT state_committed_at, status FROM sync_runs WHERE run_id = $1 FOR UPDATE", [input.run_id])).rows[0];
      if (run.state_committed_at !== null) return;
      requireValid(run.status === "running", "RUN_CONFLICT");
      for (const user of users) await client.query(`INSERT INTO users (user_id, upstream_username, observed_at) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET upstream_username = EXCLUDED.upstream_username, observed_at = EXCLUDED.observed_at`, [user.user_id, user.upstream_username, input.observed_at]);
      for (const subject of subjects) await client.query(`INSERT INTO subjects
        (subject_id, type, name, name_cn, summary, date, eps, total_episodes, nsfw, rating, content_hash, upstream_updated_at, first_seen_at, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        ON CONFLICT (subject_id) DO UPDATE SET type=EXCLUDED.type, name=EXCLUDED.name, name_cn=EXCLUDED.name_cn,
        summary=EXCLUDED.summary, date=EXCLUDED.date, eps=EXCLUDED.eps, total_episodes=EXCLUDED.total_episodes,
        nsfw=EXCLUDED.nsfw, rating=EXCLUDED.rating, content_hash=EXCLUDED.content_hash, upstream_updated_at=EXCLUDED.upstream_updated_at,
        last_seen_at=EXCLUDED.last_seen_at, missing_since=NULL, deleted_at=NULL`,
      [subject.subject_id, subject.type, subject.name, subject.name_cn, subject.summary, subject.date, subject.eps, subject.total_episodes, subject.nsfw, subject.rating ?? null, sha256(subject), subject.upstream_updated_at, input.observed_at]);
      let changed = 0;
      let missing = 0;
      let deleted = 0;
      for (const user of users) {
        for (const item of user.items) {
          const result = await client.query(`INSERT INTO collection_items
            (user_id, subject_id, collection_type, rate, tags, comment, ep_status, vol_status, private, upstream_updated_at, content_hash, first_seen_at, changed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
            ON CONFLICT (user_id, subject_id) DO UPDATE SET collection_type=EXCLUDED.collection_type, rate=EXCLUDED.rate,
            tags=EXCLUDED.tags, comment=EXCLUDED.comment, ep_status=EXCLUDED.ep_status, vol_status=EXCLUDED.vol_status,
            private=EXCLUDED.private, upstream_updated_at=EXCLUDED.upstream_updated_at, content_hash=EXCLUDED.content_hash,
            changed_at=CASE WHEN collection_items.content_hash <> EXCLUDED.content_hash THEN EXCLUDED.changed_at ELSE collection_items.changed_at END,
            missing_since=NULL, deleted_at=NULL
            WHERE collection_items.content_hash <> EXCLUDED.content_hash OR collection_items.missing_since IS NOT NULL`,
          [user.user_id, item.subject_id, item.collection_type, item.rate, JSON.stringify(item.tags), item.comment, item.ep_status, item.vol_status, item.private, item.upstream_updated_at, sha256(item), input.observed_at]);
          changed += result.rowCount ?? 0;
        }
        // Same rule as domain/collection-diff: missing once, deleted only at a later complete observation.
        const result = await client.query(`UPDATE collection_items SET
          deleted_at=CASE WHEN missing_since < $2 THEN $2 ELSE NULL END, missing_since=COALESCE(missing_since,$2)
          WHERE user_id=$1 AND NOT (subject_id=ANY($3::integer[])) AND deleted_at IS NULL RETURNING deleted_at`,
        [user.user_id, input.observed_at, user.items.map((item) => item.subject_id)]);
        missing += result.rows.filter((row) => row.deleted_at === null).length;
        deleted += result.rows.filter((row) => row.deleted_at !== null).length;
      }
      await client.query("DELETE FROM calendar_entries");
      for (const entry of calendar) await client.query("INSERT INTO calendar_entries (weekday, subject_id, observed_at) VALUES ($1,$2,$3)", [entry.weekday, entry.subject_id, input.observed_at]);
      await client.query(`UPDATE subjects SET deleted_at=CASE WHEN missing_since < $1 THEN $1 ELSE NULL END,
        missing_since=COALESCE(missing_since,$1) WHERE NOT (subject_id=ANY($2::integer[])) AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM collection_items c WHERE c.subject_id=subjects.subject_id AND c.deleted_at IS NULL)`, [input.observed_at, [...ids]]);
      await client.query(`INSERT INTO subject_media (subject_id) SELECT subject_id FROM subjects WHERE deleted_at IS NULL ON CONFLICT DO NOTHING`);
      await client.query(`UPDATE sync_runs SET stage='state_committed', state_committed_at=$2, heartbeat_at=$2,
        collection_count=$3, calendar_count=$4, changed_count=$5, missing_count=$6, deleted_count=$7 WHERE run_id=$1`,
      [input.run_id, input.observed_at, users.reduce((sum, user) => sum + user.items.length, 0), calendar.length, changed, missing, deleted]);
    });
  }

  async collectionExists(user_id: string, subject_id: number): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM collection_items WHERE user_id=$1 AND subject_id=$2 AND deleted_at IS NULL", [user_id, subject_id])).rowCount === 1;
  }

  async listDueMedia(input: { run_id: string; observed_at: number; limit: number }): Promise<MediaCandidate[]> {
    requireValid(integer(input.observed_at) && integer(input.limit, 1) && input.limit <= 10000, "INVALID_MEDIA");
    return this.transaction(async (client) => {
      await this.requireRun(client, input.run_id, input.observed_at);
      const { rows } = await client.query(`SELECT m.subject_id FROM subject_media m JOIN subjects s USING (subject_id)
        WHERE s.deleted_at IS NULL AND COALESCE(m.next_retry_at,m.next_refresh_at,0) <= $1
        AND COALESCE(m.tombstone_until,0) <= $1
        AND (m.observed_at < $1 OR (m.observed_at=$1 AND COALESCE(m.run_id,'') <= $2 COLLATE "C"))
        ORDER BY COALESCE(m.next_retry_at,m.next_refresh_at,0), m.subject_id LIMIT $3`, [input.observed_at, input.run_id, input.limit]);
      return rows.map((row) => ({ subject_id: row.subject_id, run_id: input.run_id, observed_at: input.observed_at }));
    });
  }

  async applyMediaResult(input: MediaResult): Promise<boolean> {
    requireValid(integer(input.subject_id, 1) && integer(input.observed_at) && ["ok", "failed", "not_found"].includes(input.status), "INVALID_MEDIA");
    for (const time of [input.next_refresh_at, input.next_retry_at, input.tombstone_until]) requireValid(time === undefined || integer(time), "INVALID_MEDIA");
    const detail = input.detail === undefined ? undefined : subjectProjection(input.detail);
    requireValid(detail === undefined || (detail.subject_id === input.subject_id && hashPattern.test(input.detail_hash ?? "")), "INVALID_MEDIA");
    for (const [key, hash] of [[input.common_key, input.common_hash], [input.large_key, input.large_hash]]) {
      requireValid((key === undefined && hash === undefined) || (key === null && hash === null)
        || (typeof key === "string" && typeof hash === "string" && hashPattern.test(hash) && (key === `images/${hash}/original` || key === `shadow/images/${hash}/original`)), "INVALID_MEDIA");
    }
    this.safe({ detail, detail_hash: input.detail_hash, common_key: input.common_key, common_hash: input.common_hash, large_key: input.large_key, large_hash: input.large_hash });
    return this.transaction(async (client) => {
      await this.requireRun(client, input.run_id, input.observed_at);
      const row = (await client.query("SELECT observed_at, run_id FROM subject_media WHERE subject_id=$1 FOR UPDATE", [input.subject_id])).rows[0];
      requireValid(Boolean(row), "UNKNOWN_SUBJECT");
      if (!newerOrEqual(input, { observed_at: Number(row.observed_at), run_id: row.run_id ?? "" })) return false;
      const success = input.status === "ok";
      await client.query(`UPDATE subject_media SET
        detail=CASE WHEN $4 THEN $5::jsonb ELSE detail END, detail_hash=CASE WHEN $4 THEN $6 ELSE detail_hash END,
        common_key=CASE WHEN $7 THEN $8 ELSE common_key END, common_hash=CASE WHEN $7 THEN $9 ELSE common_hash END,
        large_key=CASE WHEN $10 THEN $11 ELSE large_key END, large_hash=CASE WHEN $10 THEN $12 ELSE large_hash END,
        status=$13, observed_at=$2, run_id=$3, checked_at=$2,
        last_success_at=CASE WHEN $14 THEN $2 ELSE last_success_at END,
        next_refresh_at=COALESCE($15,next_refresh_at), next_retry_at=$16, tombstone_until=$17,
        retry_count=CASE WHEN $14 THEN 0 ELSE retry_count+1 END, error_code=$18 WHERE subject_id=$1`,
      [input.subject_id, input.observed_at, input.run_id, success && detail !== undefined, detail ?? null, input.detail_hash ?? null,
        success && input.common_key !== undefined, input.common_key ?? null, input.common_hash ?? null,
        success && input.large_key !== undefined, input.large_key ?? null, input.large_hash ?? null,
        input.status, success, input.next_refresh_at ?? null, success ? null : input.next_retry_at ?? null,
        input.status === "not_found" ? input.tombstone_until ?? null : null, success ? null : code(input.error_code)]);
      return true;
    });
  }

  async getPublicationState(): Promise<PublicationState> {
    return (await this.pool.query<PublicationState>("SELECT verified, pending, claimed FROM publications WHERE singleton=true")).rows[0];
  }

  private publication(input: Publication): Publication {
    requireValid(integer(input.generation, 1) && hashPattern.test(input.content_hash)
      && input.object_key === `snapshots/v1/${input.generation}-${input.content_hash}.json`
      && integer(input.published_at) && integer(input.observed_at) && integer(input.item_count)
      && identityPattern.test(input.run_id) && /^[0-9a-f]{40}$/.test(input.git_sha), "INVALID_PUBLICATION");
    const result = { generation: input.generation, content_hash: input.content_hash, object_key: input.object_key,
      published_at: input.published_at, observed_at: input.observed_at, run_id: input.run_id, item_count: input.item_count, git_sha: input.git_sha };
    this.safe(result);
    return result;
  }

  async savePendingPublication(input: Publication, claim: "keep" | "claim" | "release" = "keep"): Promise<{ outcome: "pending" | "replay" | "no_change"; publication: Publication }> {
    const next = this.publication(input);
    requireValid(["keep", "claim", "release"].includes(claim), "INVALID_PUBLICATION");
    return this.transaction(async (client) => {
      await this.requireRun(client, next.run_id, next.observed_at);
      const state = (await client.query<PublicationState>("SELECT verified, pending, claimed FROM publications WHERE singleton=true FOR UPDATE")).rows[0];
      if (state.verified) requireValid(newerOrEqual(next, state.verified), "STALE_OBSERVATION");
      if (state.verified?.content_hash === next.content_hash) {
        if (!state.claimed && (!state.pending || newerOrEqual(next, state.pending))) await client.query("UPDATE publications SET pending=NULL WHERE singleton=true");
        return { outcome: "no_change", publication: state.verified };
      }
      requireValid(next.generation === (state.verified?.generation ?? 0) + 1, "GENERATION_CONFLICT");
      const exact = state.pending !== null && JSON.stringify(this.publication(state.pending)) === JSON.stringify(next);
      requireValid(!state.claimed || exact, "PUBLICATION_CLAIMED");
      if (state.pending) requireValid(newerOrEqual(next, state.pending), "STALE_OBSERVATION");
      requireValid(claim !== "release" || exact, "PUBLICATION_CONFLICT");
      await client.query("UPDATE publications SET pending=$1, claimed=$2 WHERE singleton=true", [next, claim === "claim" || (claim === "keep" && exact && state.claimed)]);
      return { outcome: exact ? "replay" : "pending", publication: next };
    });
  }

  async verifyPublication(input: Publication): Promise<"verified" | "replay"> {
    const next = this.publication(input);
    return this.transaction(async (client) => {
      const state = (await client.query<PublicationState>("SELECT verified, pending, claimed FROM publications WHERE singleton=true FOR UPDATE")).rows[0];
      const same = (value: Publication | null) => value !== null && JSON.stringify(this.publication(value)) === JSON.stringify(next);
      if (same(state.verified)) return "replay";
      requireValid(same(state.pending) && state.claimed && next.generation === (state.verified?.generation ?? 0) + 1, "PUBLICATION_CONFLICT");
      await client.query("UPDATE publications SET verified=pending, pending=NULL, claimed=false WHERE singleton=true");
      return "verified";
    });
  }

  async finishRun(run_id: string, result: RunFinish): Promise<void> {
    requireValid(["success", "no_change", "partial", "failed", "skipped"].includes(result.status)
      && integer(result.completed_at) && ["not_attempted", "verified", "no_change", "failed"].includes(result.publication)
      && [result.backup, result.notification].every((value) => ["not_attempted", "success", "failed"].includes(value))
      && integer(result.media_succeeded ?? 0) && integer(result.media_failed ?? 0), "INVALID_RUN_RESULT");
    const durations: Record<string, number> = {};
    for (const stage of ["fetch", "state", "media", "publication", "backup", "notification"] as const) {
      const value = result.durations?.[stage];
      if (value !== undefined) { requireValid(integer(value), "INVALID_RUN_RESULT"); durations[stage] = value; }
    }
    const updated = await this.pool.query(`UPDATE sync_runs SET stage='finished', status=$2, completed_at=$3, heartbeat_at=$3,
      publication=$4, backup=$5, notification=$6, error_code=$7, media_succeeded=$8, media_failed=$9, durations=$10
      WHERE run_id=$1 AND observed_at <= $3 AND (status='running' OR (status=$2 AND publication=$4 AND backup=$5))`,
    [run_id, result.status, result.completed_at, result.publication, result.backup, result.notification, code(result.error_code), result.media_succeeded ?? 0, result.media_failed ?? 0, durations]);
    requireValid(updated.rowCount === 1, "RUN_CONFLICT");
  }
}
