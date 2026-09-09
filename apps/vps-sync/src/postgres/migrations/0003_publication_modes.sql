-- Preserve the pre-mode singleton as live while making shadow state durable and isolated.
ALTER TABLE publications ADD COLUMN mode text NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live', 'shadow'));
ALTER TABLE publications DROP CONSTRAINT publications_pkey;
ALTER TABLE publications ADD PRIMARY KEY (mode);
INSERT INTO publications (mode) VALUES ('shadow') ON CONFLICT (mode) DO NOTHING;
