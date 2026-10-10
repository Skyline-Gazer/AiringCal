-- Jobs-only additions; apply alongside repo migrations/ before first node-jobs run.

CREATE TABLE IF NOT EXISTS airingcal_job_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS airingcal_job_runs (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  observed_at INTEGER,
  status TEXT NOT NULL,
  generation INTEGER,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS airingcal_job_inputs (
  run_id TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, chunk)
);

CREATE TABLE IF NOT EXISTS airingcal_job_media (
  subject_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  next_refresh_at INTEGER NOT NULL,
  source_hash TEXT NOT NULL
);
