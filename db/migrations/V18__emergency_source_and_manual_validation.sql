-- Integracion con el bus EDA (ADR #25): marca las emergencias nacidas de
-- eventos externos para separarlas del flujo del boton de panico, y
-- permite flaguear las que llegan incompletas para revision humana.

ALTER TABLE emergencies
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'INTERNAL',
    ADD COLUMN IF NOT EXISTS requires_manual_validation BOOLEAN NOT NULL DEFAULT false;

-- Catalogo cerrado de origenes. INTERNAL = boton de panico / ciudadano;
-- EXTERNAL = evento del bus EDA mapeado a emergencia (p. ej. cobertura
-- preventiva por EventoComunitarioPublicado).
ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_source_check
    CHECK (source IN ('INTERNAL', 'EXTERNAL'));

-- Dispatcher filtra por "las que requieren decision humana" para que las
-- emergencias con lat/lng faltante por el bus suban al tope del tablero.
CREATE INDEX IF NOT EXISTS idx_emergencies_requires_manual_validation
    ON emergencies (requires_manual_validation)
    WHERE requires_manual_validation = true;

-- LiberarCoberturaPreventiva busca por (correlation_id, source=EXTERNAL,
-- status=PENDING). Un indice parcial por source=EXTERNAL mantiene el lookup
-- rapido sin inflar el ya existente idx_emergencies_correlation_id.
CREATE INDEX IF NOT EXISTS idx_emergencies_external_pending
    ON emergencies (correlation_id)
    WHERE source = 'EXTERNAL' AND status = 'PENDING';
