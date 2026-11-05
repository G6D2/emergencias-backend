-- Deduplicacion de eventos externos (issue #65, ADR #25).
-- El listener consume at-least-once: ON CONFLICT DO NOTHING descarta duplicados.
-- tryMarkProcessed + efectos del evento van en la misma transaccion; el commit
-- de offset en Kafka se dispara recien despues del COMMIT de esta tabla.
--
-- Un evento que no se puede procesar por un error permanente (payload
-- invalido, type sin handler, constraint) queda registrado como DISCARDED con
-- el motivo: el offset avanza y no se reentrega para siempre.

CREATE TABLE IF NOT EXISTS eventos_procesados (
    event_id        UUID        PRIMARY KEY,
    source          TEXT        NOT NULL,
    event_type      TEXT        NOT NULL,
    causation_id    UUID,
    status          TEXT        NOT NULL DEFAULT 'PROCESSED',
    discard_reason  TEXT,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT eventos_procesados_source_nonempty
        CHECK (length(trim(source)) > 0),
    CONSTRAINT eventos_procesados_event_type_nonempty
        CHECK (length(trim(event_type)) > 0),
    CONSTRAINT eventos_procesados_status_check
        CHECK (status IN ('PROCESSED', 'DISCARDED')),
    CONSTRAINT eventos_procesados_discard_reason_check
        CHECK ((status = 'DISCARDED') = (discard_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_eventos_procesados_source_type
    ON eventos_procesados (source, event_type);

CREATE INDEX IF NOT EXISTS idx_eventos_procesados_processed_at
    ON eventos_procesados (processed_at);
