#!/usr/bin/env node
/**
 * Encola EmergenciaVinculadaAContextoZona (con backfill: true) para los
 * vínculos de emergencia_contexto_zona que siguen en la base y todavía no
 * tienen evento en el outbox. Se corre una vez al encender
 * EVENTO_VINCULO_CONTEXTO_ENABLED (ADR "Publicar el vínculo de una emergencia
 * con un contexto de zona", puntos 6 y 8). Es idempotente.
 *
 * Solo recupera lo que la retención no borró: los vínculos de emergencias ya
 * anonimizadas no existen más.
 *
 * Uso:
 *   npm run backfill:vinculos-contexto
 */
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { EmergencyRepository } = require('../src/repositories/emergency.repository');
const { zoneContextLinkEventEnabled } = require('../src/services/emergency-events');
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
  const host = databaseHostLabel();
  if (!zoneContextLinkEventEnabled()) {
    console.error(
      'EVENTO_VINCULO_CONTEXTO_ENABLED no está en true: no se encola nada. '
      + 'Encenderlo recién cuando el tipo esté registrado en el catálogo del gateway.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`backfill-vinculos-contexto → ${host}`);
  const repository = new EmergencyRepository(getPool());
  const result = await repository.enqueueMissingZoneContextLinkEvents();
  secureLog('info', 'backfill-vinculos-contexto completed', { host, ...result });
  console.log(
    `Encolados ${result.enqueuedCount} eventos de vínculo en ${host}`
    + ` (${result.skippedCount} vínculos sin publicar por categoría)`
  );
  await closePool();
}

main().catch(async (error) => {
  secureLog('error', 'backfill-vinculos-contexto failed', { message: error.message });
  await closePool().catch(() => {});
  process.exit(1);
});
