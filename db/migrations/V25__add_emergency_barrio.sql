-- Barrio en claro (catálogo oficial CABA, 48 barrios).
-- Derivado en la app por punto-en-polígono al crear la emergencia.
-- La ubicación exacta sigue cifrada; LOCATION_RETENTION_HOURS no toca esta columna.

ALTER TABLE emergencies
    ADD COLUMN IF NOT EXISTS barrio TEXT;

CREATE INDEX IF NOT EXISTS idx_emergencies_barrio
    ON emergencies (barrio)
    WHERE barrio IS NOT NULL;
