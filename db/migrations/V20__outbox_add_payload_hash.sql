-- Soporte para publisher HTTP al gateway EDA (ADR #25).
--
-- payload_hash: lo devuelve el gateway en la respuesta 202 (SHA-256 del body).
-- Permite deduplificar reintentos: si el gateway respondio 504 ("puede haberse
-- publicado igual"), al reintentar comparamos el hash para no ensuciar el bus.
--
-- gateway_event_id: eventId que estampo el gateway en metadata.eventId. Util
-- para auditoria y para correlacionar nuestros outbox rows con eventos del bus.
--
-- Ambos quedan NULL hasta que EDA_PUBLISHER_MODE=gateway esta activo. Las filas
-- publicadas via Kafka directo (comportamiento actual) nunca los pueblan.

ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS payload_hash TEXT,
    ADD COLUMN IF NOT EXISTS gateway_event_id UUID;

-- Lookup rapido para dedup contra 504 (reintentos del mismo payload).
CREATE INDEX IF NOT EXISTS idx_outbox_events_payload_hash
    ON outbox_events (payload_hash)
    WHERE payload_hash IS NOT NULL;
