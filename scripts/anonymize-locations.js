#!/usr/bin/env node
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { EmergencyRepository } = require('../src/repositories/emergency.repository');
const { createLocationCrypto } = require('../src/security/location-crypto');
const { secureLog } = require('../src/security/secure-log');

async function main() {
  const hours = Number(process.env.LOCATION_RETENTION_HOURS ?? 72);
  createLocationCrypto(); // validate key
  const repository = new EmergencyRepository(getPool());
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
