ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_severity_check
    CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical'));