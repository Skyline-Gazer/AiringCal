CREATE TABLE IF NOT EXISTS airingcal_operations (
  id TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS airingcal_operations_expiry ON airingcal_operations(expires_at);
