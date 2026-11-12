#!/usr/bin/env node
/**
 * Completa emergencies.latitud_aprox/longitud_aprox (V29) en las emergencias
 * creadas antes de la migración, descifrando su ubicación. Sin esto, las que
 * estén abiertas no suben de prioridad cerca de un evento. Las anonimizadas
 * no se tocan.
 *
 * Uso:
 *   npm run security:backfill-coordenadas-aproximadas
 *   npm run security:backfill-coordenadas-aproximadas -- --dry-run
 */
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { EmergencyRepository } = require('../src/repositories/emergency.repository');
const { secureLog } = require('../src/security/secure-log');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const repository = new EmergencyRepository(getPool());
  const result = await repository.backfillApproximateCoords({ dryRun });
  secureLog('info', 'backfill-coordenadas-aproximadas completed', { dryRun, updatedCount: result.updatedCount });
  console.log(`${dryRun ? 'Would update' : 'Updated'} ${result.updatedCount} emergencies`);
  await closePool();
}

main().catch(async (error) => {
  secureLog('error', 'backfill-coordenadas-aproximadas failed', { message: error.message });
  await closePool().catch(() => {});
  process.exit(1);
});
