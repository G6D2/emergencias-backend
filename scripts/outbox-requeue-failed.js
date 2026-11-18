#!/usr/bin/env node
/**
 * Resuelve eventos FAILED del outbox (issue #104): un FAILED frena a los
 * eventos posteriores de su emergencia hasta que se lo reencola o se lo
 * descarta. Ver src/services/outbox-failed.js.
 *
 * Uso:
 *   npm run outbox:requeue-failed                            # lista, no cambia nada
 *   npm run outbox:requeue-failed -- --id <uuid> --apply     # reencola ese evento
 *   npm run outbox:requeue-failed -- --apply                 # reencola todos los FAILED
 *   npm run outbox:requeue-failed -- --id <uuid> --skip --apply  # lo descarta (SKIPPED)
 */
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { parseRequeueFailedArgs, resolveFailedEvents, USAGE } = require('../src/services/outbox-failed');
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

async function main() {
  let options;
  try {
    options = parseRequeueFailedArgs(process.argv.slice(2));
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
  let action = 'listar';
  if (options.apply) action = options.discard ? 'descartar' : 'reencolar';
  console.log(`outbox-requeue-failed (${action}) → ${host}`);
  const rows = await resolveFailedEvents(getPool(), options);
  rows.forEach((row) => {
    console.log(`${row.id}  ${row.type || row.topic}  emergencia=${row.emergencia_id || '-'}  intentos=${row.attempts}  ${String(row.last_error || '').slice(0, 120)}`);
  });
  if (options.apply) {
    secureLog('info', 'outbox-requeue-failed completed', { host, action, count: rows.length });
    console.log(`${rows.length} eventos FAILED ${options.discard ? 'descartados (SKIPPED)' : 'reencolados (PENDING)'}`);
  } else {
    console.log(`${rows.length} eventos FAILED. Nada cambió: agregá --apply para reencolarlos (o --skip --apply para descartarlos).`);
  }
  await closePool();
}

main().catch(async (error) => {
  secureLog('error', 'outbox-requeue-failed failed', { message: error.message });
  await closePool().catch(() => {});
  process.exit(1);
});
