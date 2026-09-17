ALTER TABLE sync_runs
  ADD COLUMN notification_failed jsonb
  CHECK (notification_failed IS NULL OR jsonb_typeof(notification_failed) = 'object');
