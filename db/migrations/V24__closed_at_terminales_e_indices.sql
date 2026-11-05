-- Sweep técnico del flujo de emergencias.
--
-- 1. closed_at en todos los estados terminales. Hasta V23 solo la transición
--    a CLOSED lo seteaba, así que la retención de ubicaciones (72 h desde
--    closed_at) nunca alcanzaba a las CANCELLED ni a las DISCARDED. Desde
--    ahora la app lo setea en cualquier transición terminal; acá se rellena
--    con updated_at en las que ya estaban cerradas sin fecha. Las PENDING
--    viejas no se tocan (decisión de Producto).

UPDATE emergencies
SET closed_at = updated_at
WHERE status IN ('CLOSED', 'CANCELLED', 'DISCARDED')
  AND closed_at IS NULL;

-- 2. Índices alineados con las queries reales.
--
--    El purge del outbox borra los PUBLISHED por published_at; el índice de
--    V8 estaba sobre created_at.

DROP INDEX IF EXISTS idx_outbox_events_published_created_at;

CREATE INDEX IF NOT EXISTS idx_outbox_events_published_published_at
    ON outbox_events (published_at)
    WHERE status = 'PUBLISHED';

--    La retención de ubicaciones filtra por closed_at entre las filas sin
--    anonimizar. El índice de V3 estaba sobre created_at y su predicado
--    (location_encrypted IS NOT NULL) no lo implica la query, que también
--    limpia filas legacy con lat/lng en claro: no se podía usar.

DROP INDEX IF EXISTS idx_emergencies_location_retention;

CREATE INDEX IF NOT EXISTS idx_emergencies_location_retention_closed_at
    ON emergencies (closed_at)
    WHERE location_anonymized_at IS NULL;
