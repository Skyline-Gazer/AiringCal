ALTER TABLE collection_items
  ADD COLUMN missing_run_id uuid REFERENCES sync_runs(id),
  ADD CONSTRAINT collection_items_missing_observation
    CHECK ((missing_since IS NULL) = (missing_run_id IS NULL));

ALTER TABLE subject_media
  ADD COLUMN observed_run_id uuid REFERENCES sync_runs(id),
  ADD CONSTRAINT subject_media_observation_fence
    CHECK ((observed_at IS NULL) = (observed_run_id IS NULL));
