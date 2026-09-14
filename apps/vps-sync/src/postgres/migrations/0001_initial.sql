CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id text PRIMARY KEY,
  upstream_username text NOT NULL,
  observed_at bigint NOT NULL CHECK (observed_at >= 0)
);

CREATE TABLE sync_runs (
  run_id text PRIMARY KEY COLLATE "C",
  observed_at bigint NOT NULL CHECK (observed_at >= 0),
  source text NOT NULL CHECK (source IN ('cron', 'manual')),
  mode text NOT NULL CHECK (mode IN ('shadow', 'live')),
  git_sha text NOT NULL CHECK (git_sha ~ '^[0-9a-f]{40}$'),
  stage text NOT NULL DEFAULT 'started' CHECK (stage IN ('started', 'state_committed', 'finished')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'no_change', 'partial', 'failed', 'skipped')),
  heartbeat_at bigint NOT NULL,
  state_committed_at bigint,
  completed_at bigint,
  collection_count integer NOT NULL DEFAULT 0 CHECK (collection_count >= 0),
  calendar_count integer NOT NULL DEFAULT 0 CHECK (calendar_count >= 0),
  changed_count integer NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  missing_count integer NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  deleted_count integer NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
  media_succeeded integer NOT NULL DEFAULT 0 CHECK (media_succeeded >= 0),
  media_failed integer NOT NULL DEFAULT 0 CHECK (media_failed >= 0),
  durations jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(durations) = 'object'),
  error_code text CHECK (error_code IN ('UNKNOWN', 'UPSTREAM_AUTH', 'UPSTREAM_NOT_FOUND', 'UPSTREAM_RATE_LIMIT', 'UPSTREAM_TIMEOUT', 'UPSTREAM_NETWORK', 'UPSTREAM_SERVER', 'UPSTREAM_CONTRACT', 'DATABASE', 'MEDIA_INVALID', 'MEDIA_UPLOAD', 'PUBLICATION', 'BACKUP', 'NOTIFICATION', 'LOCK_UNAVAILABLE')),
  publication text NOT NULL DEFAULT 'not_attempted' CHECK (publication IN ('not_attempted', 'verified', 'no_change', 'failed')),
  backup text NOT NULL DEFAULT 'not_attempted' CHECK (backup IN ('not_attempted', 'success', 'failed')),
  notification text NOT NULL DEFAULT 'not_attempted' CHECK (notification IN ('not_attempted', 'success', 'failed'))
);

CREATE TABLE subjects (
  subject_id integer PRIMARY KEY CHECK (subject_id > 0),
  type integer NOT NULL CHECK (type BETWEEN 1 AND 6),
  name text NOT NULL,
  name_cn text NOT NULL,
  summary text NOT NULL,
  date text NOT NULL,
  eps integer NOT NULL CHECK (eps >= 0),
  total_episodes integer NOT NULL CHECK (total_episodes >= 0),
  nsfw boolean NOT NULL,
  rating jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  upstream_updated_at text,
  first_seen_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  missing_since bigint,
  deleted_at bigint
);

CREATE TABLE collection_items (
  user_id text NOT NULL REFERENCES users(user_id),
  subject_id integer NOT NULL REFERENCES subjects(subject_id),
  collection_type integer NOT NULL CHECK (collection_type BETWEEN 1 AND 5),
  rate integer NOT NULL CHECK (rate BETWEEN 0 AND 10),
  tags jsonb NOT NULL CHECK (jsonb_typeof(tags) = 'array'),
  comment text NOT NULL,
  ep_status integer NOT NULL CHECK (ep_status >= 0),
  vol_status integer NOT NULL CHECK (vol_status >= 0),
  private boolean NOT NULL,
  upstream_updated_at text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  first_seen_at bigint NOT NULL,
  changed_at bigint NOT NULL,
  missing_since bigint,
  deleted_at bigint,
  PRIMARY KEY (user_id, subject_id),
  CHECK (deleted_at IS NULL OR missing_since IS NOT NULL)
);

CREATE TABLE subject_media (
  subject_id integer PRIMARY KEY REFERENCES subjects(subject_id),
  detail jsonb,
  detail_hash text CHECK (detail_hash ~ '^[0-9a-f]{64}$'),
  common_key text,
  common_hash text CHECK (common_hash ~ '^[0-9a-f]{64}$'),
  large_key text,
  large_hash text CHECK (large_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed', 'not_found')),
  observed_at bigint NOT NULL DEFAULT 0,
  run_id text COLLATE "C" REFERENCES sync_runs(run_id),
  checked_at bigint,
  last_success_at bigint,
  next_refresh_at bigint,
  next_retry_at bigint,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  tombstone_until bigint,
  error_code text,
  CHECK ((common_key IS NULL) = (common_hash IS NULL)),
  CHECK ((large_key IS NULL) = (large_hash IS NULL))
);

CREATE TABLE calendar_entries (
  weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  subject_id integer NOT NULL REFERENCES subjects(subject_id),
  observed_at bigint NOT NULL,
  PRIMARY KEY (weekday, subject_id)
);

CREATE TABLE publications (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  verified jsonb,
  pending jsonb,
  claimed boolean NOT NULL DEFAULT false,
  CHECK (verified IS NULL OR jsonb_typeof(verified) = 'object'),
  CHECK (pending IS NULL OR jsonb_typeof(pending) = 'object'),
  CHECK (NOT claimed OR pending IS NOT NULL)
);
INSERT INTO publications (singleton) VALUES (true);

CREATE INDEX collection_items_subject ON collection_items(subject_id) WHERE deleted_at IS NULL;
CREATE INDEX subject_media_due ON subject_media(next_retry_at, next_refresh_at);
