-- Alerta climática como contexto de zona (ADR "Elevar la prioridad con
-- contextos de zona por radio o por barrio").
--
-- V31 cambió la zona de un barrio a un punto con radio. Eso sirve para
-- situaciones puntuales, como un evento comunitario. Una alerta climática
-- llega por barrios y sin coordenadas. Desde acá, un contexto tiene una de dos
-- zonas: punto + radio, o una lista de barrios. Lo que dice la cabecera de V31
-- ("deja de ser un barrio") vale solo para los eventos. V31 no se edita
-- porque Flyway valida el checksum de las migraciones ya aplicadas.
--
-- - barrios: nombres canónicos del catálogo (src/domain/barrio.js). Se
--   comparan al leer contra emergencies.barrio, así que alcanzan a las
--   emergencias abiertas, se hayan creado antes o después de la alerta.
-- - tipos_emergencia: tipos de emergencia que el contexto eleva. NULL eleva
--   todos (menos PREVENTIVA), como los eventos comunitarios. Un array vacío no
--   eleva ninguno: una alerta LEVE o MEDIA existe y se avisa, pero no sube
--   ninguna prioridad.
-- - fenomeno, gravedad: para el motivo de la suba y el banner del tablero.
-- - version_origen: versión del objeto en el módulo de origen. Una versión
--   menor que la guardada no pisa nada.

ALTER TABLE contexto_zona
    ADD COLUMN IF NOT EXISTS barrios          TEXT[],
    ADD COLUMN IF NOT EXISTS tipos_emergencia TEXT[],
    ADD COLUMN IF NOT EXISTS fenomeno         TEXT,
    ADD COLUMN IF NOT EXISTS gravedad         TEXT,
    ADD COLUMN IF NOT EXISTS version_origen   INTEGER;

-- Los tipos son el catálogo de src/domain/emergency-type.js (el mismo del
-- CHECK de V10).
ALTER TABLE contexto_zona
    ADD CONSTRAINT contexto_zona_barrios_check
        CHECK (barrios IS NULL OR cardinality(barrios) > 0),
    ADD CONSTRAINT contexto_zona_gravedad_check
        CHECK (gravedad IS NULL OR gravedad IN ('LEVE', 'MEDIA', 'ALTA', 'EXTREMA')),
    ADD CONSTRAINT contexto_zona_tipos_emergencia_check
        CHECK (tipos_emergencia IS NULL OR tipos_emergencia <@ ARRAY[
            'MEDICA', 'INCENDIO', 'INFRAESTRUCTURA', 'DISTURBIO_EVENTO_MASIVO',
            'OTRO', 'PANICO', 'PREVENTIVA', 'TRANSITO'
        ]::text[]),
    ADD CONSTRAINT contexto_zona_version_origen_check
        CHECK (version_origen IS NULL OR version_origen >= 0);

-- Un contexto que no está dado de baja tiene ventana y alguna zona: punto +
-- radio, o al menos un barrio. NOT VALID, por lo mismo que en V31: los
-- contextos que quedaron de V28 (sin punto ni barrios) siguen sin alcanzar a
-- nadie, y la restricción vale para toda escritura nueva.
ALTER TABLE contexto_zona DROP CONSTRAINT IF EXISTS contexto_zona_vigente_completo_check;
ALTER TABLE contexto_zona
    ADD CONSTRAINT contexto_zona_vigente_completo_check
        CHECK (
            dado_de_baja_en IS NOT NULL
            OR (vigente_desde IS NOT NULL AND vigente_hasta IS NOT NULL
                AND ((latitud IS NOT NULL AND longitud IS NOT NULL AND radio_metros IS NOT NULL)
                     OR barrios IS NOT NULL))
        ) NOT VALID;
