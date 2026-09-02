-- Tabla emergencies para el flujo del botón de pánico.
--
-- Notas:
-- - user_id es lo que manda hoy el panic button (payload.userId).
--   Todavía no hay JWT/Auth, así que no hay FK a una tabla de ciudadanos.
-- - latitude/longitude van como columnas simples (sin PostGIS): por ahora
--   solo hace falta guardar y devolver el punto, no queries geo.
-- - status arranca en 'CREATED'. Las transiciones válidas las valida la app.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE emergencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    description TEXT,
    severity TEXT,
    status TEXT NOT NULL DEFAULT 'CREATED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_emergencies_status ON emergencies (status);
CREATE INDEX idx_emergencies_user_id ON emergencies (user_id);
