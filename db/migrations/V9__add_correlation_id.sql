-- Tarea #58: correlationId propio por emergencia para trazar la cadena
-- creación → priorización → despacho en los eventos.
-- Decisión (G6D2/ADRs#10, ADR-001 pregunta 2): correlation_id = id al crear.
-- No se usa para agrupar incidentes.
ALTER TABLE emergencies
    ADD COLUMN correlation_id UUID;

-- Filas existentes: se les asigna su propio id (idempotente).
UPDATE emergencies
SET correlation_id = id
WHERE correlation_id IS NULL;

CREATE INDEX idx_emergencies_correlation_id ON emergencies (correlation_id);
