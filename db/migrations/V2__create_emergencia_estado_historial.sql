-- Historial de cambios de status de una emergency.
--
-- actor y reason son nullable: todavía no hay Auth (a veces no sabemos quién
-- hizo el cambio) y no todo cambio necesita un motivo.

CREATE TABLE emergency_status_history (
    id BIGSERIAL PRIMARY KEY,
    emergency_id UUID NOT NULL REFERENCES emergencies (id) ON DELETE CASCADE,
    previous_status TEXT,
    new_status TEXT NOT NULL,
    actor TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_history_emergency_id ON emergency_status_history (emergency_id);
