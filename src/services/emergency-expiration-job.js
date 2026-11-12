const { secureLog } = require('../security/secure-log');
const { buildEmergencyUpdatedEvent } = require('./emergency-events');

const ACTOR = 'sistema:expiracion';

function emergenciaActualizadaTopic(env) {
  return env.TOPIC_EMERGENCIA_ESTADO_ACTUALIZADO || 'emergencias.estado-actualizado';
}

/**
 * Job de expiración: una emergencia abierta que lleva más de N horas sin
 * cambiar de estado pasa a un estado terminal y su ubicación se anonimiza en
 * el mismo paso (ver EmergencyRepository.expireStaleEmergencies).
 *
 * N es EMERGENCY_EXPIRATION_HOURS y, si no está, LOCATION_RETENTION_HOURS (72):
 * por defecto la ubicación de una emergencia abandonada dura lo mismo que la de
 * una cerrada. Cada expiración deja historial (actor `sistema:expiracion`) y
 * publica EmergenciaActualizada, para que los otros módulos den de baja el
 * incidente.
 */
function startEmergencyExpirationJob(emergencyRepository, options = {}) {
  const env = options.env || process.env;
  const enabled = env.EMERGENCY_EXPIRATION_ENABLED !== 'false';
  const hours = Number(env.EMERGENCY_EXPIRATION_HOURS ?? env.LOCATION_RETENTION_HOURS ?? 72);
  const intervalMs = Number(env.EMERGENCY_EXPIRATION_INTERVAL_MS ?? 60 * 60 * 1000);

  if (!enabled) {
    secureLog('info', 'Emergency expiration job disabled');
    return { stop() {} };
  }

  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('EMERGENCY_EXPIRATION_HOURS must be a positive number');
  }

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error('EMERGENCY_EXPIRATION_INTERVAL_MS must be >= 1000');
  }

  const reason = `Expirada: sin cambios de estado en ${hours} h`;
  const outboxEvent = {
    topic: emergenciaActualizadaTopic(env),
    payload: ({ emergency, history }, eventId) => buildEmergencyUpdatedEvent({
      emergency,
      history,
      actor: ACTOR,
      reason,
      eventId,
    }),
  };

  async function runOnce() {
    try {
      const result = await emergencyRepository.expireStaleEmergencies(hours, {
        actor: ACTOR,
        reason,
        outboxEvent,
      });
      if (result.expiredCount > 0 || result.failedCount > 0) {
        secureLog('info', 'Emergency expiration closed stale emergencies', {
          count: result.expiredCount,
          failed: result.failedCount,
          hours,
        });
      }
      return result;
    } catch (error) {
      secureLog('error', 'Emergency expiration job failed', { message: error.message });
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

module.exports = { startEmergencyExpirationJob, ACTOR };
