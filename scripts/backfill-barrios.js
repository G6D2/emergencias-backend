#!/usr/bin/env node
/**
 * Completa emergencies.barrio en filas que todavía tienen ubicación
 * descifrable y barrio vacío. Las ya anonimizadas se dejan sin barrio.
 *
 * Uso: npm run security:backfill-barrios
 */
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { EmergencyRepository } = require('../src/repositories/emergency.repository');
const { createLocationCrypto } = require('../src/security/location-crypto');
const { secureLog } = require('../src/security/secure-log');

async function main() {
  createLocationCrypto();
  const repository = new EmergencyRepository(getPool());
  const result = await repository.backfillBarrios();
  secureLog('info', 'backfill-barrios completed', {
    updatedCount: result.updatedCount,
    ids: result.ids,
  });
  console.log(`Updated ${result.updatedCount} emergencies`);
  await closePool();
}

main().catch(async (error) => {
  secureLog('error', 'backfill-barrios failed', { message: error.message });
  await closePool().catch(() => {});
  process.exit(1);
});
