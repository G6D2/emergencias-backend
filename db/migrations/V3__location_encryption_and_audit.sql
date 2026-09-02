-- Ubicación sensible: cifrado en reposo + retención / anonimización.
--
-- - location_encrypted: ciphertext AES-256-GCM (app). Lat/lng en claro dejan
--   de escribirse en inserts nuevos (quedan NULL).
-- - location_anonymized_at: cuándo se borró el ciphertext por política de retención.
-- - emergency_access_audit: quién leyó una emergencia (dispatcher / citizen).

ALTER TABLE emergencies
  ADD COLUMN IF NOT EXISTS location_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS location_anonymized_at TIMESTAMPTZ;

ALTER TABLE emergencies
  ALTER COLUMN latitude DROP NOT NULL,
  ALTER COLUMN longitude DROP NOT NULL;

CREATE TABLE IF NOT EXISTS emergency_access_audit (
  id BIGSERIAL PRIMARY KEY,
  emergency_id UUID NOT NULL REFERENCES emergencies (id) ON DELETE CASCADE,
  actor_sub TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_audit_emergency_id
  ON emergency_access_audit (emergency_id);

CREATE INDEX IF NOT EXISTS idx_access_audit_actor_sub
  ON emergency_access_audit (actor_sub);

CREATE INDEX IF NOT EXISTS idx_emergencies_location_retention
  ON emergencies (created_at)
  WHERE location_encrypted IS NOT NULL AND location_anonymized_at IS NULL;
