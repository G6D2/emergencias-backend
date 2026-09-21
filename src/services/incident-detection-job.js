const { secureLog } = require('../security/secure-log');
const { EMERGENCY_TYPES } = require('../domain/emergency-type');
const { processEmergencyTypeCandidates } = require('../domain/incident-detector');

// Constante arbitraria pero FIJA para pg_try_advisory_lock/pg_advisory_unlock:
// identifica a este job entre cualquier otro advisory lock que corra contra
// la misma base (bigint de 32 bits, sin significado más allá de "no la
// cambies sin coordinar" — si dos procesos usan claves distintas, el lock no
// sirve de nada). Hoy no hay otro advisory lock en el código.
const DETECTION_LOCK_KEY = 875312047;

/**
 * Ejecuta `fn` bajo un lock exclusivo a nivel de base de datos (no solo del
 * proceso): dos instancias del backend contra la misma Neon (primary +
 * backup de failover, ver ADRs) podrían correr el job al mismo tiempo y
 * crear incidentes duplicados si solo hubiera un guard `running` en memoria.
 * `pg_try_advisory_lock` no bloquea: si otra instancia ya tiene el lock,
 * esta corrida se saltea (hay otra corrida cada 60s, no hace falta esperar).
 * El lock se toma en una conexión DEDICADA (no la del pool general) porque
 * es un lock de sesión: vive atado a esa conexión y se libera explícitamente
 * con pg_advisory_unlock en el finally (o al cerrarse la conexión).
 */
async function withDetectionLock(pool, fn) {
  if (!pool) {
    // Sin pool (tests unitarios de puro dominio/job que no ejercitan el
    // lock): corre sin lock, igual que antes de esta feature.
    return fn();
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [DETECTION_LOCK_KEY]);
    const locked = rows[0] && rows[0].locked;

    if (!locked) {
      secureLog('debug', 'Incident detection job: lock ocupado por otra instancia, se saltea esta corrida', {
        lockKey: DETECTION_LOCK_KEY,
      });
      return undefined;
    }

    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [DETECTION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * Job de deteccion de incidentes (tarea #60, parte 2/2): agrupa emergencias
 * cercanas del mismo tipo dentro de una ventana temporal, calcula prioridad
 * con el rule-based grouper y persiste la decision via IncidentRepository.
 */
function startIncidentDetectionJob(emergencyRepository, incidentRepository, options = {}) {
  const env = options.env || process.env;
  const pool = options.pool || null;
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

  let running = false;

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      try {
        await withDetectionLock(pool, async () => {
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
        });
      } catch (error) {
        secureLog('error', 'Incident detection job failed', { message: error.message });
      }
    } finally {
      running = false;
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

module.exports = { startIncidentDetectionJob, withDetectionLock, DETECTION_LOCK_KEY };
