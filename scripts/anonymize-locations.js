#!/usr/bin/env node
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { EmergencyRepository } = require('../src/repositories/emergency.repository');
const { createLocationCrypto } = require('../src/security/location-crypto');
const { secureLog } = require('../src/security/secure-log');

// Uso:
//   node scripts/anonymize-locations.js                  → filas vencidas (retención)
//   node scripts/anonymize-locations.js --undecryptable  → filas cuyo ciphertext no
//                                                          abre con la clave actual
async function main() {
  createLocationCrypto(); // validate key
  const repository = new EmergencyRepository(getPool());

  if (process.argv.includes('--undecryptable')) {
    const result = await repository.anonymizeUndecryptableLocations();
    secureLog('info', 'Undecryptable location anonymization finished', {
      anonymizedCount: result.anonymizedCount,
      ids: result.ids,
    });
    await closePool();
    return;
  }

  const hours = Number(process.env.LOCATION_RETENTION_HOURS ?? 72);
  const result = await repository.anonymizeExpiredLocations(hours);
  secureLog('info', 'Manual location anonymization finished', {
    retentionHours: hours,
    anonymizedCount: result.anonymizedCount,
  });
  await closePool();
}

main().catch(async (error) => {
  secureLog('error', 'Manual anonymization failed', { message: error.message });
  await closePool().catch(() => {});
  process.exit(1);
});
