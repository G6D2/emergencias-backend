-- Caso "reclamo ciudadano que desencadena una intervención" (issue #37 del
-- board): un ReclamoCreado de Reclamos con categoria TRANSITO sobre una
-- CICLOVIA crea una emergencia externa con causa RECLAMO.
--
-- - TRANSITO entra al catálogo de tipos (espejo de src/domain/emergency-type.js).
-- - El CHECK de incidents también lo acepta: el job de detección agrupa por
--   tipo y guarda el del grupo. De paso suma PREVENTIVA, que faltaba desde V23.
-- - Una sola emergencia por reclamo: Kafka entrega al menos una vez y el
--   reclamo puede republicarse.

ALTER TABLE emergencies
    DROP CONSTRAINT IF EXISTS emergencies_emergency_type_check;

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_emergency_type_check
    CHECK (
        emergency_type IS NULL
        OR emergency_type IN (
            'MEDICA', 'INCENDIO', 'INFRAESTRUCTURA', 'DISTURBIO_EVENTO_MASIVO', 'OTRO', 'PANICO',
            'PREVENTIVA', 'TRANSITO'
        )
    );

ALTER TABLE incidents
    DROP CONSTRAINT IF EXISTS incidents_emergency_type_check;

ALTER TABLE incidents
    ADD CONSTRAINT incidents_emergency_type_check
    CHECK (
        emergency_type IS NULL
        OR emergency_type IN (
            'MEDICA', 'INCENDIO', 'INFRAESTRUCTURA', 'DISTURBIO_EVENTO_MASIVO', 'OTRO', 'PANICO',
            'PREVENTIVA', 'TRANSITO'
        )
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_emergencies_reclamo_causa
    ON emergencies (causa_id)
    WHERE causa_tipo = 'RECLAMO';
