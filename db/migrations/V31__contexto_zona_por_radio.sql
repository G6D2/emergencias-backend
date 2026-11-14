-- El contexto de zona deja de ser un barrio y pasa a ser un punto con radio:
-- eleva la prioridad de las emergencias creadas a no más de radio_metros del
-- evento mientras está ocurriendo. El barrio afectaba toda la zona (Palermo
-- entero por un evento en una plaza) y dejaba afuera la vereda de enfrente si
-- era otro barrio.
--
-- La ubicación de la emergencia sigue cifrada y no se guarda en claro: la
-- distancia se mide en la aplicación al crear la emergencia, cuando la
-- coordenada todavía está en memoria, y solo se guarda el resultado (qué
-- contextos la alcanzan) en emergencia_contexto_zona.

-- 1. Contexto de zona: punto y radio en lugar de barrio. La ubicación de un
--    evento público no es dato personal: va en claro.
DROP INDEX IF EXISTS idx_contexto_zona_barrio_vigencia;

ALTER TABLE contexto_zona
    DROP CONSTRAINT IF EXISTS contexto_zona_vigente_completo_check,
    DROP COLUMN IF EXISTS barrio,
    ADD COLUMN IF NOT EXISTS latitud      DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitud     DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS radio_metros INTEGER;

ALTER TABLE contexto_zona
    ADD CONSTRAINT contexto_zona_latitud_check
        CHECK (latitud IS NULL OR latitud BETWEEN -90 AND 90),
    ADD CONSTRAINT contexto_zona_longitud_check
        CHECK (longitud IS NULL OR longitud BETWEEN -180 AND 180),
    ADD CONSTRAINT contexto_zona_radio_check
        CHECK (radio_metros IS NULL OR radio_metros > 0);

-- Un contexto que no está dado de baja siempre tiene punto, radio y ventana.
-- NOT VALID: los contextos creados por barrio (V28) quedan sin punto y no
-- alcanzan a ninguna emergencia hasta que Espacios republique el evento; la
-- restricción vale para toda escritura nueva.
ALTER TABLE contexto_zona
    ADD CONSTRAINT contexto_zona_vigente_completo_check
        CHECK (
            dado_de_baja_en IS NOT NULL
            OR (latitud IS NOT NULL AND longitud IS NOT NULL AND radio_metros IS NOT NULL
                AND vigente_desde IS NOT NULL AND vigente_hasta IS NOT NULL)
        ) NOT VALID;

-- Al crear una emergencia se buscan los contextos en curso (son pocos).
CREATE INDEX IF NOT EXISTS idx_contexto_zona_vigencia
    ON contexto_zona (vigente_desde, vigente_hasta)
    WHERE dado_de_baja_en IS NULL;

-- 2. Qué contextos alcanzan a cada emergencia. Se escribe una sola vez, al
--    crear la emergencia. No guarda coordenadas ni distancia. La prioridad
--    sube mientras el contexto vinculado siga en curso: eso se evalúa al leer,
--    así que baja sola cuando el evento termina, se suspende o se cancela.
CREATE TABLE IF NOT EXISTS emergencia_contexto_zona (
    emergency_id UUID        NOT NULL REFERENCES emergencies(id) ON DELETE CASCADE,
    contexto_id  UUID        NOT NULL REFERENCES contexto_zona(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (emergency_id, contexto_id)
);

CREATE INDEX IF NOT EXISTS idx_emergencia_contexto_zona_contexto
    ON emergencia_contexto_zona (contexto_id);
