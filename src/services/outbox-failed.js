// Issue #104: herramienta para los eventos FAILED del outbox.
//
// Desde el #104 una fila solo queda FAILED por un error propio del evento
// (400/403/404/413 del gateway, 401 tras renovar el token): las caídas del bus
// ya no la llevan ahí. Una FAILED frena a los eventos posteriores de su
// emergencia (claimBatch), así que hay que resolverla a mano:
// - reencolarla (vuelve a PENDING) cuando se corrigió la causa, por ejemplo
//   un tipo que faltaba registrar en el catálogo del gateway;
// - o descartarla (SKIPPED) si no tiene arreglo; los posteriores salen igual.
//
// Lo usa scripts/outbox-requeue-failed.js (npm run outbox:requeue-failed).

const { isUuid } = require('../utils/uuid');
const { EMERGENCY_KEY_SQL } = require('./outbox-publisher');

const FAILED_COLUMNS = `id, topic, payload->>'type' AS type,
       ${EMERGENCY_KEY_SQL('outbox_events')} AS emergencia_id,
       attempts, created_at, last_error`;
// $1: ids a tocar, o NULL para todos los FAILED.
const FAILED_FILTER = `status = 'FAILED' AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`;

const LIST_FAILED_SQL = `SELECT ${FAILED_COLUMNS} FROM outbox_events
   WHERE ${FAILED_FILTER}
   ORDER BY created_at, id`;
// Reencolada: disponible ya. attempts no se toca (la guarda de reclamo del
// #114 compara contra ese valor) y last_error queda hasta el próximo envío.
const REQUEUE_FAILED_SQL = `UPDATE outbox_events
   SET status = 'PENDING', available_at = now(), locked_at = NULL
   WHERE ${FAILED_FILTER}
   RETURNING ${FAILED_COLUMNS}`;
const DISCARD_FAILED_SQL = `UPDATE outbox_events
   SET status = 'SKIPPED', locked_at = NULL,
       last_error = left('descartado a mano (outbox:requeue-failed --skip): ' || COALESCE(last_error, ''), 2000)
   WHERE ${FAILED_FILTER}
   RETURNING ${FAILED_COLUMNS}`;

const USAGE = `Uso: npm run outbox:requeue-failed -- [--id <uuid>]... [--skip] [--apply]
  sin --apply   lista los FAILED que tocaría, sin cambiar nada
  --apply       los reencola (PENDING); con --skip los descarta (SKIPPED)
  --id <uuid>   solo esos eventos (se puede repetir); sin --id, todos los FAILED`;

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ ids: string[], discard: boolean, apply: boolean, help: boolean }}
 */
function parseRequeueFailedArgs(argv) {
  const options = { ids: [], discard: false, apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--skip') options.discard = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--id') {
      const id = argv[index + 1];
      if (!isUuid(id)) throw new Error(`--id necesita un UUID (vino ${id === undefined ? 'nada' : `"${id}"`})`);
      options.ids.push(id);
      index += 1;
    } else {
      throw new Error(`Argumento desconocido: ${arg}`);
    }
  }
  return options;
}

/**
 * Lista (sin apply), reencola o descarta eventos FAILED.
 * @returns {Promise<object[]>} las filas afectadas (o las que se afectarían)
 */
async function resolveFailedEvents(pool, { ids = [], discard = false, apply = false } = {}) {
  const params = [ids.length > 0 ? ids : null];
  let sql = LIST_FAILED_SQL;
  if (apply) sql = discard ? DISCARD_FAILED_SQL : REQUEUE_FAILED_SQL;
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = { parseRequeueFailedArgs, resolveFailedEvents, USAGE };
