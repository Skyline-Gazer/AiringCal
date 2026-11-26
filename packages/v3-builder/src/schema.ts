export const BUILDER_SCHEMA_VERSION = 2 as const

export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS v3_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS builder_job_leases (
    job_id TEXT PRIMARY KEY,
    owner_token TEXT NOT NULL,
    expires_at_unix INTEGER NOT NULL,
    updated_at_unix INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS builder_kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at_unix INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_runs (
    run_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
    started_at_unix INTEGER NOT NULL,
    finished_at_unix INTEGER,
    detail_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS subject_media (
    subject_id INTEGER PRIMARY KEY,
    detail_json TEXT,
    detail_hash TEXT,
    media_hash TEXT,
    nsfw INTEGER NOT NULL DEFAULT 0 CHECK (nsfw IN (0, 1)),
    source_image_common_url TEXT,
    source_image_large_url TEXT,
    r2_image_common_key TEXT,
    r2_image_large_key TEXT,
    checked_at INTEGER,
    next_refresh_at INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    retry_after INTEGER,
    error_code TEXT
  )`,
  // #195 P3 — internal checkpoint state, NEVER projected into the public
  // snapshot. v3_collections is the reconciliation ledger (content hash +
  // missing/deleted tombstones via planCollectionDiff); v3_episode_progress
  // keeps per-episode watch states including non-contiguous gaps and the
  // catalog episode type (0 本篇 / 1 SP / 2 OP / 3 ED) for specials/OVA.
  `CREATE TABLE IF NOT EXISTS v3_collections (
    user_id TEXT NOT NULL,
    subject_id INTEGER NOT NULL,
    collection_type INTEGER NOT NULL,
    rate INTEGER,
    tags_json TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    ep_status INTEGER NOT NULL,
    vol_status INTEGER NOT NULL,
    upstream_updated_at TEXT,
    subject_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    temperature TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    changed_at INTEGER NOT NULL,
    missing_since INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, subject_id)
  )`,
  `CREATE TABLE IF NOT EXISTS v3_episode_progress (
    user_id TEXT NOT NULL,
    subject_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    collection_type INTEGER NOT NULL CHECK (collection_type IN (0, 1, 2, 3)),
    episode_type INTEGER,
    sort REAL,
    ep REAL,
    airdate TEXT,
    updated_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, subject_id, episode_id)
  )`,
]
