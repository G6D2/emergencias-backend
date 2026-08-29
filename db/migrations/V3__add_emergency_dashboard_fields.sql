ALTER TABLE emergencias
    ADD COLUMN assigned_officer_id TEXT,
    ADD COLUMN emergency_type TEXT;

CREATE INDEX idx_emergencias_assigned_officer_id ON emergencias (assigned_officer_id);
CREATE INDEX idx_emergencias_emergency_type ON emergencias (emergency_type);
CREATE INDEX idx_emergencias_created_at ON emergencias (created_at DESC);