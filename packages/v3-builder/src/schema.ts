export const BUILDER_SCHEMA_VERSION = 1 as const

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
]
