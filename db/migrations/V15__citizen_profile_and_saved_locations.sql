-- Perfil ciudadano y ubicaciones frecuentes (fuera del browser).
-- Campos sensibles van cifrados (AES-256-GCM, mismo keyring que location_encrypted).

CREATE TABLE IF NOT EXISTS citizen_profiles (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    sensitive_encrypted TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS citizen_saved_locations (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    location_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_citizen_saved_locations_user_id
    ON citizen_saved_locations (user_id);
