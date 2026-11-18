// Herramienta para los eventos externos DISCARDED (ver "Reprocesar un evento
// DISCARDED" en src/listeners/README.md).
//
// Un DISCARDED no frena a nadie: el offset avanzó y el resto del tópico
// siguió. La fila queda en eventos_procesados para que una reentrega del mismo
// eventId no se vuelva a procesar. Para reprocesar el MISMO mensaje (reset de
// offset del grupo) primero hay que borrar esa fila. Si el productor lo
// republica por el gateway, sale con otro eventId y no hace falta borrar nada.
//
// - Sin --apply solo lista.
// - Con --id <uuid> --apply borra esas filas, solo si están DISCARDED. Nunca
//   una PROCESSED: su reentrega aplicaría los efectos dos veces. Nunca en
//   masa: --apply exige al menos un --id.
//
// Borrar la fila no reprocesa nada por sí solo: el evento entra recién cuando
// Kafka vuelva a entregar ese mensaje.
//
// Lo usa scripts/eventos-descartados.js (npm run eventos:descartados).

const { isUuid } = require('../utils/uuid');

const DEFAULT_LIMIT = 50;

const DISCARDED_COLUMNS = `event_id, source, event_type, processed_at,
       left(discard_reason, 200) AS discard_reason`;

// $1: ids a mostrar, o NULL para todos los DISCARDED. $2: tope de filas.
const LIST_DISCARDED_SQL = `SELECT ${DISCARDED_COLUMNS} FROM eventos_procesados
   WHERE status = 'DISCARDED' AND ($1::uuid[] IS NULL OR event_id = ANY($1::uuid[]))
   ORDER BY processed_at DESC, event_id
   LIMIT $2`;
const DELETE_DISCARDED_SQL = `DELETE FROM eventos_procesados
   WHERE status = 'DISCARDED' AND event_id = ANY($1::uuid[])
   RETURNING ${DISCARDED_COLUMNS}`;

const USAGE = `Uso: npm run eventos:descartados -- [--id <uuid>]... [--limit <n>] [--apply]
  sin --apply   lista los DISCARDED de eventos_procesados (los más nuevos primero), sin cambiar nada
  --id <uuid>   solo esos eventos (se puede repetir)
  --limit <n>   cuántos listar (default ${DEFAULT_LIMIT})
  --apply       borra la fila de dedup de esos --id, solo si están DISCARDED, para que
                una reentrega del mismo mensaje se vuelva a procesar (exige --id)`;

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ ids: string[], limit: number, apply: boolean, help: boolean }}
 */
function parseDiscardedArgs(argv) {
  const options = { ids: [], limit: DEFAULT_LIMIT, apply: false, help: false };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--id') {
      const id = args.shift();
      if (!isUuid(id)) {
        const received = id === undefined ? 'nada' : `"${id}"`;
        throw new Error(`--id necesita un UUID (vino ${received})`);
      }
      options.ids.push(id);
    } else if (arg === '--limit') {
      const raw = args.shift();
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`--limit necesita un entero mayor que 0 (vino ${raw === undefined ? 'nada' : `"${raw}"`})`);
      }
      options.limit = limit;
    } else {
      throw new Error(`Argumento desconocido: ${arg}`);
    }
  }
  if (options.apply && options.ids.length === 0 && !options.help) {
    throw new Error('--apply necesita al menos un --id: no se borran descartados en masa');
  }
  return options;
}

/**
 * Lista (sin apply) o borra (con apply) filas DISCARDED de eventos_procesados.
 * @returns {Promise<object[]>} las filas listadas o borradas
 */
async function resolveDiscardedEvents(pool, { ids = [], limit = DEFAULT_LIMIT, apply = false } = {}) {
  if (apply) {
    if (ids.length === 0) {
      throw new Error('--apply necesita al menos un --id: no se borran descartados en masa');
    }
    const { rows } = await pool.query(DELETE_DISCARDED_SQL, [ids]);
    return rows;
  }
  const { rows } = await pool.query(LIST_DISCARDED_SQL, [ids.length > 0 ? ids : null, limit]);
  return rows;
}

module.exports = { parseDiscardedArgs, resolveDiscardedEvents, USAGE, DEFAULT_LIMIT };
