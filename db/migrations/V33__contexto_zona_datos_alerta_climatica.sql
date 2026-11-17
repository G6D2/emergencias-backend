-- Datos de la alerta climática en sus contextos de zona, para mostrarla en el
-- banner del tablero del dispatcher (GET /api/contextos-zona/activos).
--
-- Los contextos ALERTA_CLIMATICA (ADR "Responder a las alertas climáticas de
-- Espacios") guardaban el nivel y el fenómeno solo dentro de `descripcion`
-- ("Alerta climática ALTA: tormenta fuerte") y no guardaban los barrios. Estas
-- columnas los guardan aparte, en cada punto de la alerta.
--
-- Aditiva: tres columnas nullable, sin tocar las existentes. No intervienen en
-- la zona, el vínculo ni la suba (siguen siendo punto + radio, V31). Los
-- eventos comunitarios las dejan en NULL.
--
-- - nivel_criticidad: nivel de la alerta. Hoy solo ALTA o CRITICA generan
--   contextos, pero el CHECK acepta el catálogo completo de Espacios.
-- - fenomeno: código de Espacios (TORMENTA_FUERTE, GRANIZO...). Sin CHECK: el
--   catálogo lo define Espacios y un fenómeno nuevo se guarda igual.
-- - barrios: barrios que manda la alerta, solo para mostrar.

ALTER TABLE contexto_zona
    ADD COLUMN IF NOT EXISTS nivel_criticidad TEXT,
    ADD COLUMN IF NOT EXISTS fenomeno         TEXT,
    ADD COLUMN IF NOT EXISTS barrios          TEXT[];

ALTER TABLE contexto_zona
    DROP CONSTRAINT IF EXISTS contexto_zona_nivel_criticidad_check;
ALTER TABLE contexto_zona
    ADD CONSTRAINT contexto_zona_nivel_criticidad_check
        CHECK (nivel_criticidad IS NULL OR nivel_criticidad IN ('BAJA', 'MEDIA', 'ALTA', 'CRITICA'));

-- Contextos climáticos que ya existían: nivel y fenómeno salen de la
-- descripción que arma la regla ("Alerta climática <NIVEL>: <fenómeno>", con
-- el código en minúsculas y espacios). Sin fenómeno la regla escribe "evento
-- climático", que no es un código: queda NULL. Los barrios no se pueden
-- recuperar.
UPDATE contexto_zona c
   SET nivel_criticidad = d.nivel,
       fenomeno = CASE
           WHEN d.fenomeno IS NULL OR d.fenomeno = 'evento climático' THEN NULL
           ELSE upper(replace(d.fenomeno, ' ', '_'))
       END
  FROM (
      SELECT id,
             substring(descripcion FROM '^Alerta climática (ALTA|CRITICA):') AS nivel,
             btrim(substring(descripcion FROM '^Alerta climática [A-Z]+: (.+)$')) AS fenomeno
        FROM contexto_zona
       WHERE tipo = 'ALERTA_CLIMATICA'
         AND descripcion IS NOT NULL
         AND nivel_criticidad IS NULL
         AND fenomeno IS NULL
  ) d
 WHERE c.id = d.id;
