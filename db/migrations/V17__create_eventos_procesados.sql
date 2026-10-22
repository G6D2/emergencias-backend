-- Deduplicacion de eventos externos (ADR #25). El listener consume
-- at-least-once y descarta cualquier eventId ya procesado. Insertar aqui
-- + ejecutar los efectos del mapper van en la misma transaccion; el commit
-- de offset en Kafka recien se dispara despues del COMMIT de esta tabla.

CREATE TABLE IF NOT EXISTS eventos_procesados (
    event_id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    causation_id UUID,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT eventos_procesados_source_nonempty CHECK (length(trim(source)) > 0),
    CONSTRAINT eventos_procesados_event_type_nonempty CHECK (length(trim(event_type)) > 0)
);

-- Para limpieza por antiguedad y para analitica por origen.
CREATE INDEX IF NOT EXISTS idx_eventos_procesados_source_type
    ON eventos_procesados (source, event_type);

CREATE INDEX IF NOT EXISTS idx_eventos_procesados_processed_at
    ON eventos_procesados (processed_at);
