const { secureLog } = require('./secure-log');
const { schedulePeriodicJob } = require('../utils/periodic-job');

/**
 * Job de minimización PII del perfil ciudadano:
 * - limpia sensitive_encrypted de perfiles inactivos
 * - borra ubicaciones guardadas sin actualizar
 */
function startCitizenProfileRetentionJob(citizenProfileRepository, options = {}) {
  const env = options.env || process.env;
  const enabled = env.CITIZEN_PII_RETENTION_ENABLED !== 'false';
  const retentionDays = Number(env.CITIZEN_PII_RETENTION_DAYS ?? 90);
  const intervalMs = Number(
    env.CITIZEN_PII_RETENTION_INTERVAL_MS
      ?? env.LOCATION_RETENTION_INTERVAL_MS
      ?? 60 * 60 * 1000
  );

  if (!enabled) {
    secureLog('info', 'Citizen PII retention job disabled');
    return { stop() {} };
  }

  if (!citizenProfileRepository) {
    secureLog('info', 'Citizen PII retention job skipped (no repository)');
    return { stop() {} };
  }

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error('CITIZEN_PII_RETENTION_DAYS must be a positive number');
  }

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error('CITIZEN_PII_RETENTION_INTERVAL_MS must be >= 1000');
  }

  async function runOnce() {
    try {
      const profiles = await citizenProfileRepository.anonymizeStaleProfiles(retentionDays);
      const locations = await citizenProfileRepository.deleteStaleSavedLocations(retentionDays);

      if (profiles.anonymizedCount > 0 || locations.deletedCount > 0) {
        secureLog('info', 'Citizen PII retention cleaned stale data', {
          profilesAnonymized: profiles.anonymizedCount,
          locationsDeleted: locations.deletedCount,
          retentionDays,
        });
      }

      return { profiles, locations };
    } catch (error) {
      secureLog('error', 'Citizen PII retention job failed', { message: error.message });
      return null;
    }
  }

  // Primera pasada diferida para no bloquear el boot.
  return schedulePeriodicJob(runOnce, { intervalMs, firstRunDelayMs: 20_000 });
}

module.exports = { startCitizenProfileRetentionJob };
