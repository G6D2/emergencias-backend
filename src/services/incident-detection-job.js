const { secureLog } = require('../security/secure-log');
const { EMERGENCY_TYPES } = require('../domain/emergency-type');
const { processEmergencyTypeCandidates } = require('../domain/incident-detector');

/**
 * Job de deteccion de incidentes (tarea #60, parte 2/2): agrupa emergencias
 * cercanas del mismo tipo dentro de una ventana temporal, calcula prioridad
 * con el rule-based grouper y persiste la decision via IncidentRepository.
 */
function startIncidentDetectionJob(emergencyRepository, incidentRepository, options = {}) {
  const env = options.env || process.env;
  const enabled = env.INCIDENT_DETECTION_ENABLED !== 'false';
  const radiusMeters = Number(env.INCIDENT_RADIUS_M ?? 300);
  const windowMinutes = Number(env.INCIDENT_WINDOW_MIN ?? 15);
  const minUniqueCitizens = Number(env.INCIDENT_MIN_CITIZENS ?? 2);
  const intervalMs = Number(env.INCIDENT_DETECTION_INTERVAL_MS ?? 60000);

  if (!enabled) {
    secureLog('info', 'Incident detection job disabled');
    return { stop() {} };
  }

  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new Error('INCIDENT_RADIUS_M must be a positive number');
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error('INCIDENT_WINDOW_MIN must be a positive number');
  }
  if (!Number.isFinite(minUniqueCitizens) || minUniqueCitizens <= 0) {
    throw new Error('INCIDENT_MIN_CITIZENS must be a positive number');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error('INCIDENT_DETECTION_INTERVAL_MS must be >= 1000');
  }

  async function processDecision(decision) {
    let { incidentId } = decision;
    if (incidentId == null) {
      const incident = await incidentRepository.create({ emergencyType: decision.emergencyType });
      incidentId = incident.id;
    }

    for (const member of decision.members) {
      if (!member.alreadyLinked) {
        await incidentRepository.addMember(incidentId, member.emergencyId);
      }
    }

    await incidentRepository.applyScoringDecision(incidentId, {
      priority: decision.priority,
      score: decision.score,
      reasonCodes: decision.reasonCodes,
      factors: decision.factors,
      algorithmVersion: decision.algorithmVersion,
      members: decision.members,
    });
  }

  async function runOnce() {
    try {
      const since = new Date(Date.now() - windowMinutes * 60000);

      // PANICO entra al loop sin excepcion: a diferencia de un tipo de uso
      // general/anonimo, el boton de panico lo activa gente puntual que ya
      // lo solicito, asi que varias activaciones agrupadas en el tiempo y el
      // espacio son una senal MAS fuerte de incidente real, no ruido a
      // filtrar.
      for (const emergencyType of EMERGENCY_TYPES) {
        const candidates = await emergencyRepository.findRecentByType({ emergencyType, since });
        const decisions = processEmergencyTypeCandidates(candidates, {
          radiusMeters,
          minUniqueCitizens,
          emergencyType,
        });

        for (const decision of decisions) {
          if (decision.skippedReason) {
            secureLog('warn', 'Incident detection skipped a group', {
              emergencyType,
              skippedReason: decision.skippedReason,
              conflictingIncidentIds: decision.conflictingIncidentIds,
            });
            continue;
          }

          await processDecision(decision);
        }
      }
    } catch (error) {
      secureLog('error', 'Incident detection job failed', { message: error.message });
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

module.exports = { startIncidentDetectionJob };
