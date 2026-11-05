-- Emergencias nacidas de eventos externos (issue #65, ADR #25) y causa del
-- contrato de eventos (issue #48 del board).
--
-- - source distingue el flujo ciudadano (INTERNAL) de lo que crea el listener
--   (EXTERNAL). requires_manual_validation marca las que llegan sin ubicacion.
-- - causa_tipo / causa_id dicen que origino la emergencia (convencion de
--   Analitica: causaTipo/causaId). Van juntas: las dos o ninguna.
-- - Una emergencia externa no tiene ciudadano: user_id pasa a nullable, pero
--   sigue obligatorio en las internas.
-- - PREVENTIVA: despliegue preventivo ante un evento publico masivo. Se crea
--   una sola por evento (indice unico parcial).

ALTER TABLE emergencies
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'INTERNAL',
    ADD COLUMN IF NOT EXISTS requires_manual_validation BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS causa_tipo TEXT,
    ADD COLUMN IF NOT EXISTS causa_id TEXT;

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_source_check
    CHECK (source IN ('INTERNAL', 'EXTERNAL'));

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_causa_tipo_check
    CHECK (
        causa_tipo IS NULL
        OR causa_tipo IN ('EVENTO_CLIMATICO', 'RECLAMO', 'INCIDENTE_VIAL', 'EVENTO_PUBLICO', 'RESERVA')
    );

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_causa_pair_check
    CHECK ((causa_tipo IS NULL) = (causa_id IS NULL));

ALTER TABLE emergencies
    ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_user_id_internal_check
    CHECK (source = 'EXTERNAL' OR user_id IS NOT NULL);

-- Espejo de src/domain/emergency-type.js (V10 + PREVENTIVA).
ALTER TABLE emergencies
    DROP CONSTRAINT IF EXISTS emergencies_emergency_type_check;

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_emergency_type_check
    CHECK (
        emergency_type IS NULL
        OR emergency_type IN (
            'MEDICA', 'INCENDIO', 'INFRAESTRUCTURA', 'DISTURBIO_EVENTO_MASIVO', 'OTRO', 'PANICO',
            'PREVENTIVA'
        )
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_emergencies_preventiva_causa
    ON emergencies (causa_tipo, causa_id)
    WHERE emergency_type = 'PREVENTIVA';

CREATE INDEX IF NOT EXISTS idx_emergencies_causa
    ON emergencies (causa_tipo, causa_id)
    WHERE causa_id IS NOT NULL;

-- Dispatcher filtra las que requieren decision humana (sin ubicacion).
CREATE INDEX IF NOT EXISTS idx_emergencies_requires_manual_validation
    ON emergencies (requires_manual_validation)
    WHERE requires_manual_validation = true;
