CREATE TABLE users (
  id uuid PRIMARY KEY,
  upstream_user_id bigint NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subjects (
  id bigint PRIMARY KEY,
  subject_type integer NOT NULL,
  payload jsonb NOT NULL,
  content_hash text NOT NULL,
  upstream_updated_at timestamptz,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE sync_runs (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  mode text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  stage_durations jsonb NOT NULL DEFAULT '{}'::jsonb,
  git_sha text NOT NULL,
  sanitized_error jsonb,
  components jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE collection_items (
  user_id uuid NOT NULL REFERENCES users(id),
  subject_id bigint NOT NULL REFERENCES subjects(id),
  payload jsonb NOT NULL,
  content_hash text NOT NULL,
  upstream_updated_at timestamptz,
  missing_since timestamptz,
  missing_run_id uuid REFERENCES sync_runs(id),
  deleted_at timestamptz,
  observed_at timestamptz NOT NULL,
  CHECK ((missing_since IS NULL) = (missing_run_id IS NULL)),
  PRIMARY KEY (user_id, subject_id)
);

CREATE TABLE subject_media (
  subject_id bigint PRIMARY KEY REFERENCES subjects(id),
  detail jsonb,
  metadata jsonb,
  image_refs jsonb,
  detail_hash text,
  metadata_hash text,
  image_hash text,
  status jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz,
  observed_run_id uuid REFERENCES sync_runs(id),
  next_retry_at timestamptz,
  deleted_at timestamptz,
  last_success_at timestamptz,
  CHECK ((observed_at IS NULL) = (observed_run_id IS NULL))
);

CREATE TABLE calendar_entries (
  weekday_id integer NOT NULL,
  subject_id bigint NOT NULL REFERENCES subjects(id),
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (weekday_id, subject_id)
);

CREATE TABLE publications (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  verified_generation bigint NOT NULL DEFAULT 0,
  verified_content_hash text,
  verified_object_key text,
  verified_at timestamptz,
  verified_run_id uuid REFERENCES sync_runs(id),
  pending_generation bigint,
  pending_content_hash text,
  pending_object_key text,
  pending_run_id uuid REFERENCES sync_runs(id),
  pending_claimed_at timestamptz,
  pending_created_at timestamptz
);

INSERT INTO publications (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
