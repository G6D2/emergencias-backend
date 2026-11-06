ALTER TABLE emergencies
    ADD COLUMN causas_relacionadas TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
