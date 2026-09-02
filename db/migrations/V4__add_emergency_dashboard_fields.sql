ALTER TABLE emergencies
    ADD COLUMN assigned_officer_id TEXT,
    ADD COLUMN emergency_type TEXT;

CREATE INDEX idx_emergencies_assigned_officer_id ON emergencies (assigned_officer_id);
CREATE INDEX idx_emergencies_emergency_type ON emergencies (emergency_type);
CREATE INDEX idx_emergencies_created_at ON emergencies (created_at DESC);
