-- Issue #71 (ADR #25): la primera vez que arranca el listener de integracion
-- EDA, cualquier emergencia EXTERNA que haya quedado en PENDING antes de esa
-- activacion no tiene correlato en el bus (nunca llego un EventoCancelado por
-- la que la libere, ni nadie va a procesarla). Se descartan al activar.
--
-- La tabla es singleton (una sola fila, id=1) y guarda el momento exacto de la
-- primera activacion, para que el proceso sea idempotente entre reinicios y
-- entre pods: el INSERT ON CONFLICT DO NOTHING actua como candado natural.

CREATE TABLE IF NOT EXISTS listener_activation (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    first_activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    discarded_count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT listener_activation_singleton CHECK (id = 1)
);
