-- El contexto de zona deja de ser un barrio y pasa a ser un punto con radio:
-- eleva la prioridad de las emergencias a no más de radio_metros del evento.
-- El barrio afectaba toda la zona (Palermo entero por un evento en una plaza)
-- y dejaba afuera la vereda de enfrente si era otro barrio.
--
-- Para medir la distancia en SQL (y así ordenar y paginar por prioridad de
-- despacho) hace falta la ubicación de la emergencia sin descifrar: se guarda
-- la coordenada aproximada, redondeada a 3 decimales (~100 m), la misma que
-- ya viaja en claro en el bus. La exacta sigue cifrada en location_encrypted.

-- 1. Coordenada aproximada de la emergencia. Se borra junto con la ubicación
--    cuando vence la retención (LOCATION_RETENTION_HOURS).
ALTER TABLE emergencies
    ADD COLUMN IF NOT EXISTS latitud_aprox  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitud_aprox DOUBLE PRECISION;

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_coordenada_aprox_par_check
        CHECK ((latitud_aprox IS NULL) = (longitud_aprox IS NULL));

-- Filas legacy (pre-V3) que todavía tienen la coordenada en claro. Las
-- cifradas se completan con `npm run security:backfill-coordenadas-aproximadas`.
UPDATE emergencies
SET latitud_aprox = round(latitude::numeric, 3)::double precision,
    longitud_aprox = round(longitude::numeric, 3)::double precision
WHERE latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND location_anonymized_at IS NULL
  AND latitud_aprox IS NULL;

-- 2. Contexto de zona: punto y radio en lugar de barrio. La ubicación de un
--    evento público no es dato personal: va exacta y en claro.
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
-- elevan nada hasta que Espacios republique el evento; la restricción vale
-- para toda escritura nueva.
ALTER TABLE contexto_zona
    ADD CONSTRAINT contexto_zona_vigente_completo_check
        CHECK (
            dado_de_baja_en IS NOT NULL
            OR (latitud IS NOT NULL AND longitud IS NOT NULL AND radio_metros IS NOT NULL
                AND vigente_desde IS NOT NULL AND vigente_hasta IS NOT NULL)
        ) NOT VALID;

-- La lectura de emergencias busca los contextos vigentes (son pocos) y mide
-- la distancia contra cada uno.
CREATE INDEX IF NOT EXISTS idx_contexto_zona_vigencia
    ON contexto_zona (vigente_desde, vigente_hasta)
    WHERE dado_de_baja_en IS NULL;
