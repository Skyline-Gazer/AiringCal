CREATE TABLE collection_items (
  user_id TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  collection_type INTEGER NOT NULL,
  rate INTEGER,
  tags_json TEXT NOT NULL,
  comment TEXT NOT NULL,
  ep_status INTEGER NOT NULL,
  vol_status INTEGER NOT NULL,
  upstream_updated_at TEXT,
  subject_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  temperature TEXT NOT NULL CHECK (temperature IN ('hot', 'cold')),
  first_seen_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  missing_since INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, subject_id)
);

CREATE TABLE subject_media (
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
);

CREATE TABLE sync_runs (
  instance_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  generation INTEGER,
  collection_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  media_selected_count INTEGER NOT NULL DEFAULT 0,
  media_granted_count INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT,
  public_hash TEXT,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE sync_budget (
  date TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource IN ('media')),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (date, resource)
);

CREATE TABLE sync_budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource IN ('media')),
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  submission_status TEXT NOT NULL CHECK (submission_status IN ('reserved', 'submitted', 'uncertain')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
