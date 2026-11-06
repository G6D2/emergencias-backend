#!/usr/bin/env node
/**
 * Completa emergencies.barrio en filas que todavía tienen ubicación
 * descifrable y barrio vacío. Las ya anonimizadas se dejan sin barrio.
 *
 * Uso:
 *   npm run security:backfill-barrios
 *   npm run security:backfill-barrios -- --dry-run
 */
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { EmergencyRepository } = require('../src/repositories/emergency.repository');
const { createLocationCrypto } = require('../src/security/location-crypto');
const { resolveBarrio } = require('../src/domain/barrio');
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

async function previewBackfill(repository) {
  const candidates = await repository.pool.query(
    `SELECT id, latitude, longitude, location_encrypted
     FROM emergencies
     WHERE barrio IS NULL
       AND location_anonymized_at IS NULL
       AND (
         location_encrypted IS NOT NULL
         OR (latitude IS NOT NULL AND longitude IS NOT NULL)
       )`
  );

  const wouldUpdate = [];
  for (const row of candidates.rows) {
    let latitude = row.latitude != null ? Number(row.latitude) : null;
    let longitude = row.longitude != null ? Number(row.longitude) : null;
    if (row.location_encrypted) {
      try {
        const location = repository.locationCrypto.decryptLocation(row.location_encrypted);
        latitude = location.latitude;
        longitude = location.longitude;
      } catch {
        continue;
      }
    }
    const barrio = resolveBarrio({ latitude, longitude });
    if (barrio) wouldUpdate.push({ id: row.id, barrio });
  }
  return wouldUpdate;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const host = databaseHostLabel();
  console.log(`backfill-barrios → ${host}${dryRun ? ' (dry-run)' : ''}`);

  createLocationCrypto();
  const repository = new EmergencyRepository(getPool());

  if (dryRun) {
    const preview = await previewBackfill(repository);
    console.log(`Would update ${preview.length} emergencies`);
    for (const row of preview.slice(0, 20)) {
      console.log(`  ${row.id} → ${row.barrio}`);
    }
    if (preview.length > 20) console.log(`  … y ${preview.length - 20} más`);
    await closePool();
    return;
  }

  const result = await repository.backfillBarrios();
  secureLog('info', 'backfill-barrios completed', {
    host,
    updatedCount: result.updatedCount,
    ids: result.ids,
  });
  console.log(`Updated ${result.updatedCount} emergencies on ${host}`);
  await closePool();
}

main().catch(async (error) => {
  secureLog('error', 'backfill-barrios failed', { message: error.message });
  await closePool().catch(() => {});
  process.exit(1);
});
