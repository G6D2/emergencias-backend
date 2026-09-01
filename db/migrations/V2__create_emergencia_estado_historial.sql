-- Task 4: Historial de cambios de estado de una emergencia.
--
-- actor y motivo son nullable: hoy no hay Auth (no sabemos quién ejecuta el cambio)
-- y no todos los cambios necesitan un motivo. Task 9 podrá exigirlos según el caso.

CREATE TABLE emergencia_estado_historial (
    id BIGSERIAL PRIMARY KEY,
    emergencia_id UUID NOT NULL REFERENCES emergencias (id) ON DELETE CASCADE,
    estado_anterior TEXT,
    estado_nuevo TEXT NOT NULL,
    actor TEXT,
    motivo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_historial_emergencia_id ON emergencia_estado_historial (emergencia_id);
