-- Oficial de cada asignación en el historial de estados (issue #17 del board).
--
-- La vista del oficial lista sus emergencias históricas, y entre ellas van las
-- que el dispatcher le devolvió (DISPATCHED → VALIDATED). La devolución deja
-- assigned_officer_id en NULL, así que la única huella de que la tuvo es la
-- fila DISPATCHED del historial, que hasta ahora guardaba el oficial solo en
-- el texto del reason ("Assigned officer <id>").
--
-- officer_id va solo en las filas de asignación (DISPATCHED); en las demás
-- queda NULL. El backfill toma el id del reason de las filas existentes.

ALTER TABLE emergency_status_history
    ADD COLUMN IF NOT EXISTS officer_id TEXT;

UPDATE emergency_status_history
SET officer_id = substring(reason FROM '^Assigned officer (.+)$')
WHERE new_status = 'DISPATCHED'
  AND officer_id IS NULL
  AND reason LIKE 'Assigned officer %';

CREATE INDEX IF NOT EXISTS idx_history_officer_id
    ON emergency_status_history (officer_id, emergency_id)
    WHERE officer_id IS NOT NULL;
