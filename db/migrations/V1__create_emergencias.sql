-- Task 4: Persistir emergencias
-- Tabla principal de emergencias generadas por el botón de pánico (Task 2).
--
-- Notas de diseño:
-- - user_id es el identificador que hoy envía el botón de pánico (payload.userId).
--   Todavía no existe JWT/Auth, por lo que no hay FK a una tabla de ciudadanos:
--   es un identificador de texto libre hasta que el módulo de Login Federado exista.
-- - latitude/longitude se guardan como columnas simples (no PostGIS): el caso de uso
--   actual solo necesita almacenar y devolver el punto, no hacer consultas geoespaciales.
-- - status arranca en 'PENDIENTE' y es un TEXT sin restricción de valores permitidos:
--   la máquina de estados completa (transiciones válidas/inválidas) es responsabilidad
--   de Task 9. Esta migration solo deja el dato persistido.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE emergencias (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    description TEXT,
    severity TEXT,
    status TEXT NOT NULL DEFAULT 'PENDIENTE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_emergencias_status ON emergencias (status);
CREATE INDEX idx_emergencias_user_id ON emergencias (user_id);
