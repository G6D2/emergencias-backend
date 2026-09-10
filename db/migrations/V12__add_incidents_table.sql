CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  emergency_type TEXT,
  priority TEXT,
  score NUMERIC,
  reason_codes JSONB,
  algorithm_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT incidents_emergency_type_check
    CHECK (emergency_type IS NULL OR emergency_type IN (
      'MEDICA', 'INCENDIO', 'INFRAESTRUCTURA',
      'DISTURBIO_EVENTO_MASIVO', 'OTRO', 'PANICO'
    ))
);

ALTER TABLE emergencies
  ADD COLUMN incident_id UUID NULL REFERENCES incidents(id) ON DELETE SET NULL;

CREATE INDEX idx_emergencies_incident_id ON emergencies(incident_id);
