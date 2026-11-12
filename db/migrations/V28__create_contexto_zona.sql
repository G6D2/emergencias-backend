-- Contexto de zona (ADR "Elevar temporalmente la prioridad con contextos de
-- zona"). Una situación de la ciudad (hoy: un evento en un espacio público)
-- que sube un nivel la prioridad de despacho de las emergencias de un barrio
-- mientras está vigente. La prioridad guardada (emergencies.severity) no se
-- toca: el ajuste se calcula al leer, así que baja solo cuando el contexto
-- vence o se da de baja.
--
-- - Un contexto por objeto de origen (tipo + origen + referencia_externa).
-- - La baja es lógica (dado_de_baja_en) y definitiva: un alta que llega
--   después de la baja no lo revive.
-- - La suspensión (suspendido_en) es reversible: Espacios suspende un evento
--   por un motivo temporal y lo puede reanudar. Mientras está suspendido el
--   contexto no eleva nada; al reanudarse vuelve a pesar en lo que quede de
--   su ventana.
-- - Una baja puede llegar antes que su alta: queda una fila ya dada de baja,
--   sin barrio ni ventana. Por eso esas columnas son nullable, pero un
--   contexto que no está dado de baja siempre las tiene.
-- - barrio usa los nombres del catálogo oficial de CABA, igual que
--   emergencies.barrio (V25).

CREATE TABLE IF NOT EXISTS contexto_zona (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo                TEXT        NOT NULL,
    barrio              TEXT,
    vigente_desde       TIMESTAMPTZ,
    vigente_hasta       TIMESTAMPTZ,
    origen              TEXT        NOT NULL,
    referencia_externa  TEXT        NOT NULL,
    -- Nombre del objeto de origen (título del evento), para mostrar el motivo.
    descripcion         TEXT,
    causation_id        UUID,
    source_updated_at   TIMESTAMPTZ NOT NULL,
    suspendido_en       TIMESTAMPTZ,
    dado_de_baja_en     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT contexto_zona_tipo_check
        CHECK (tipo IN ('EVENTO_ESPACIO_PUBLICO', 'ALERTA_CLIMATICA')),
    CONSTRAINT contexto_zona_origen_nonempty
        CHECK (length(trim(origen)) > 0),
    CONSTRAINT contexto_zona_referencia_nonempty
        CHECK (length(trim(referencia_externa)) > 0),
    CONSTRAINT contexto_zona_vigente_completo_check
        CHECK (
            dado_de_baja_en IS NOT NULL
            OR (barrio IS NOT NULL AND vigente_desde IS NOT NULL AND vigente_hasta IS NOT NULL)
        ),
    CONSTRAINT contexto_zona_ventana_check
        CHECK (vigente_desde IS NULL OR vigente_hasta IS NULL OR vigente_hasta > vigente_desde),
    CONSTRAINT uq_contexto_zona_referencia
        UNIQUE (tipo, origen, referencia_externa)
);

-- La lectura de emergencias busca contextos vigentes por barrio.
CREATE INDEX IF NOT EXISTS idx_contexto_zona_barrio_vigencia
    ON contexto_zona (barrio, vigente_desde, vigente_hasta)
    WHERE dado_de_baja_en IS NULL;
