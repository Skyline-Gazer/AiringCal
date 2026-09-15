ALTER TABLE subject_media
  ADD COLUMN component_state jsonb
  CHECK (component_state IS NULL OR jsonb_typeof(component_state) = 'object');
