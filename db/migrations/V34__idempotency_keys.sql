-- Idempotency-Key en el alta del botón de pánico (compromiso del Hito 1).
--
-- El BFF del front manda un Idempotency-Key por pedido lógico y lo repite en
-- cada reintento. Una fila por (alta, usuario, clave): si llega otro pedido
-- con la misma clave del mismo usuario dentro de la ventana (24 h), el backend
-- devuelve la emergencia de esta fila en vez de crear otra.
--
-- - La fila se inserta en la misma transacción que la emergencia y su evento
--   del outbox. La clave primaria resuelve la carrera entre dos pedidos
--   simultáneos: el segundo INSERT espera a que el primero confirme y recién
--   ahí ve la fila (o la toma, si el primero falló y se deshizo).
-- - No guarda el cuerpo de la respuesta: tendría la ubicación en claro, fuera
--   de la columna cifrada y de la retención. La respuesta repetida se arma
--   leyendo la emergencia.
-- - La FK es diferida porque la clave se reserva antes de insertar la
--   emergencia (así un reintento no hace trabajo de más). Si se borra la
--   emergencia, se borra la clave.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    scope           TEXT        NOT NULL,
    user_sub        TEXT        NOT NULL,
    idempotency_key TEXT        NOT NULL,
    emergency_id    UUID        NOT NULL
        REFERENCES emergencies (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    status_code     SMALLINT    NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT idempotency_keys_pkey PRIMARY KEY (scope, user_sub, idempotency_key)
);

-- Purga de las claves vencidas (DELETE ... WHERE created_at < ...).
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
    ON idempotency_keys (created_at);

-- ON DELETE CASCADE desde emergencies.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_emergency_id
    ON idempotency_keys (emergency_id);
