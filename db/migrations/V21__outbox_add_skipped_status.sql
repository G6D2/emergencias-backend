-- Agregar estado SKIPPED al CHECK de outbox_events (issue #71).
--
-- Caso de uso: al activar KAFKA_ENABLED / EDA_PUBLISHER_MODE en un entorno
-- donde ya quedaron PENDING de pruebas anteriores, el publisher los marca
-- como SKIPPED al arrancar en vez de inundar a los consumidores con eventos
-- viejos. El piso temporal lo define OUTBOX_PUBLISH_SINCE (ISO 8601).
--
-- Los SKIPPED NO entran al índice idx_outbox_events_pending (filtra por
-- status IN ('PENDING','PROCESSING')) ni al de PUBLISHED, así que no suman
-- costo de I/O al polling.

ALTER TABLE outbox_events
    DROP CONSTRAINT outbox_events_status_check,
    ADD CONSTRAINT outbox_events_status_check
      CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'SKIPPED'));
