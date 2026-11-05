const { secureLog } = require('./secure-log');

/**
 * Job de retención: anonimiza ubicaciones cifradas después de N horas.
 */
function startLocationRetentionJob(emergencyRepository, options = {}) {
  const env = options.env || process.env;
  const enabled = env.LOCATION_RETENTION_ENABLED !== 'false';
  const retentionHours = Number(env.LOCATION_RETENTION_HOURS ?? 72);
  const intervalMs = Number(env.LOCATION_RETENTION_INTERVAL_MS ?? 60 * 60 * 1000);

  if (!enabled) {
    secureLog('info', 'Location retention job disabled');
    return { stop() {} };
  }

  if (!Number.isFinite(retentionHours) || retentionHours <= 0) {
    throw new Error('LOCATION_RETENTION_HOURS must be a positive number');
  }

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error('LOCATION_RETENTION_INTERVAL_MS must be >= 1000');
  }

  async function runOnce() {
    try {
      // anonymizeExpiredLocations ya deriva barrio (si faltaba) antes de borrar
      // la ubicación; no hace falta un backfill previo en cada tick.
      const result = await emergencyRepository.anonymizeExpiredLocations(retentionHours);
      if (result.anonymizedCount > 0) {
        secureLog('info', 'Location retention anonymized emergencies', {
          count: result.anonymizedCount,
          retentionHours,
        });
      }
      return result;
    } catch (error) {
      secureLog('error', 'Location retention job failed', { message: error.message });
      return null;
    }
  }

  // Primera pasada diferida para no bloquear el boot.
  const initialTimeout = setTimeout(() => {
    runOnce();
  }, Math.min(intervalMs, 15_000));

  const timer = setInterval(() => {
    runOnce();
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  if (typeof initialTimeout.unref === 'function') initialTimeout.unref();

  return {
    runOnce,
    stop() {
      clearTimeout(initialTimeout);
      clearInterval(timer);
    },
  };
}

module.exports = { startLocationRetentionJob };
