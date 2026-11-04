-- Integracion con el bus EDA (issue #65): distingue emergencias del flujo
-- ciudadano (INTERNAL) de las nacidas de eventos externos (EXTERNAL), y
-- permite flaguear las que llegan incompletas para revision humana.

ALTER TABLE emergencies
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'INTERNAL',
    ADD COLUMN IF NOT EXISTS requires_manual_validation BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE emergencies
    ADD CONSTRAINT emergencies_source_check
    CHECK (source IN ('INTERNAL', 'EXTERNAL'));

-- Dispatcher filtra las que requieren decision humana (lat/lng faltantes del bus).
CREATE INDEX IF NOT EXISTS idx_emergencies_requires_manual_validation
    ON emergencies (requires_manual_validation)
    WHERE requires_manual_validation = true;

-- LiberarCoberturaPreventiva busca por (correlation_id, source=EXTERNAL, status=PENDING).
CREATE INDEX IF NOT EXISTS idx_emergencies_external_pending
    ON emergencies (correlation_id)
    WHERE source = 'EXTERNAL' AND status = 'PENDING';
