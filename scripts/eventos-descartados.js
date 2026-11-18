#!/usr/bin/env node
/**
 * Eventos externos DISCARDED en eventos_procesados (ver "Reprocesar un evento
 * DISCARDED" en src/listeners/README.md y src/services/eventos-descartados.js).
 *
 * Uso:
 *   npm run eventos:descartados                              # lista, no cambia nada
 *   npm run eventos:descartados -- --id <uuid>               # muestra ese evento
 *   npm run eventos:descartados -- --id <uuid> --apply       # borra su fila de dedup (solo si es DISCARDED)
 */
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { parseDiscardedArgs, resolveDiscardedEvents, USAGE } = require('../src/services/eventos-descartados');
const { secureLog } = require('../src/security/secure-log');
const { parseDatabaseUrl } = require('./lib/db-url');

function databaseHostLabel() {
  try {
    const info = parseDatabaseUrl(process.env.DATABASE_URL || '');
    return `${info.host}:${info.port}/${info.database}`;
  } catch {
    return '(DATABASE_URL inválida o ausente)';
  }
}

function printRow(row) {
  const when = row.processed_at instanceof Date ? row.processed_at.toISOString() : row.processed_at;
  console.log(`${row.event_id}  ${row.event_type}  source=${row.source}  ${when}  ${String(row.discard_reason || '').slice(0, 120)}`);
}

async function main() {
  let options;
  try {
    options = parseDiscardedArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const host = databaseHostLabel();
  console.log(`eventos-descartados (${options.apply ? 'borrar dedup' : 'listar'}) → ${host}`);
  const rows = await resolveDiscardedEvents(getPool(), options);
  rows.forEach(printRow);

  if (options.apply) {
    secureLog('info', 'eventos-descartados: filas DISCARDED borradas', { host, count: rows.length });
    const deleted = new Set(rows.map((row) => row.event_id));
    const missing = options.ids.filter((id) => !deleted.has(id));
    if (missing.length > 0) {
      console.log(`Sin cambios para ${missing.join(', ')}: no existe o no está DISCARDED (una PROCESSED nunca se borra).`);
    }
    console.log(`${rows.length} filas DISCARDED borradas. Esto solo no reprocesa nada: falta que Kafka vuelva a entregar el mensaje (ver src/listeners/README.md).`);
  } else {
    console.log(`${rows.length} eventos DISCARDED (hasta ${options.limit}). Nada cambió.`);
  }
  await closePool();
}

main().catch(async (error) => {
  secureLog('error', 'eventos-descartados failed', { message: error.message });
  await closePool().catch(() => {});
  process.exit(1);
});
