-- Deduplicacion de eventos externos (issue #65).
-- El listener consume at-least-once: ON CONFLICT DO NOTHING descarta duplicados.
-- tryMarkProcessed + efectos del evento van en la misma transaccion; el commit
-- de offset en Kafka se dispara recien despues del COMMIT de esta tabla.

CREATE TABLE IF NOT EXISTS eventos_procesados (
    event_id      UUID        PRIMARY KEY,
    source        TEXT        NOT NULL,
    event_type    TEXT        NOT NULL,
    causation_id  UUID,
    processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT eventos_procesados_source_nonempty
        CHECK (length(trim(source)) > 0),
    CONSTRAINT eventos_procesados_event_type_nonempty
        CHECK (length(trim(event_type)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_eventos_procesados_source_type
    ON eventos_procesados (source, event_type);

CREATE INDEX IF NOT EXISTS idx_eventos_procesados_processed_at
    ON eventos_procesados (processed_at);
