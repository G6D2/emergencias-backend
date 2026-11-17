const { secureLog } = require('../security/secure-log');
const { schedulePeriodicJob } = require('../utils/periodic-job');
const { EMERGENCY_TYPES } = require('../domain/emergency-type');
const { processEmergencyTypeCandidates } = require('../domain/incident-detector');

// Constante arbitraria pero FIJA para pg_try_advisory_xact_lock: identifica
// a este job entre cualquier otro advisory lock que corra contra la misma
// base (bigint de 32 bits, sin significado más allá de "no la cambies sin
// coordinar" — si dos procesos usan claves distintas, el lock no sirve de
// nada). Hoy no hay otro advisory lock en el código.
const DETECTION_LOCK_KEY = 875312047;

// PANICO entra sin excepcion: a diferencia de un tipo de uso general/anonimo,
// el boton de panico lo activa gente puntual que ya lo solicito, asi que
// varias activaciones agrupadas en el tiempo y el espacio son una senal MAS
// fuerte de incidente real, no ruido a filtrar.
// PREVENTIVA no es un reporte ciudadano: la crea el listener ante un evento
// publico, asi que no se agrupa en incidentes.
const GROUPABLE_EMERGENCY_TYPES = Object.freeze(EMERGENCY_TYPES.filter((type) => type !== 'PREVENTIVA'));

/**
 * Ejecuta `fn` bajo un lock exclusivo a nivel de base de datos (no solo del
 * proceso): dos instancias del backend contra la misma Neon (primary +
 * backup de failover, ver ADRs) podrían correr el job al mismo tiempo y
 * crear incidentes duplicados si solo hubiera un guard `running` en memoria.
 * `pg_try_advisory_xact_lock` no bloquea: si otra instancia ya tiene el lock,
 * esta corrida se saltea (hay otra corrida cada 60s, no hace falta esperar).
 *
 * El lock es de transacción y se toma en una conexión DEDICADA: vive lo que
 * vive la transacción y se suelta solo con el COMMIT (o al cortarse la
 * conexión). Un lock de sesión no sirve detrás del pooler de Neon (PgBouncer
 * en modo transacción): el lock y el unlock pueden caer en conexiones
 * distintas del servidor y el lock queda tomado.
 * Las escrituras del job van por otras conexiones del pool, así que esta
 * transacción queda ociosa mientras tanto: set_config(..., true) apaga
 * idle_in_transaction_session_timeout solo para ella, para que el timeout
 * del pool no la corte (y suelte el lock) a mitad de una corrida.
 */
async function withDetectionLock(pool, fn) {
  if (!pool) {
    // Sin pool (tests unitarios de puro dominio/job que no ejercitan el
    // lock): corre sin lock, igual que antes de esta feature.
    return fn();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT pg_try_advisory_xact_lock($1) AS locked,
              set_config('idle_in_transaction_session_timeout', '0', true)`,
      [DETECTION_LOCK_KEY]
    );
    const locked = rows[0] && rows[0].locked;

    if (!locked) {
      secureLog('debug', 'Incident detection job: lock ocupado por otra instancia, se saltea esta corrida', {
        lockKey: DETECTION_LOCK_KEY,
      });
      return undefined;
    }

    return await fn();
  } finally {
    // Cerrar la transacción suelta el lock. Si ni eso anda, la conexión está
    // rota y se descarta en vez de volver al pool.
    let connectionError;
    await client.query('COMMIT').catch((error) => {
      connectionError = error;
    });
    client.release(connectionError);
  }
}

function groupByEmergencyType(candidates) {
  const byType = new Map();
  for (const candidate of candidates) {
    const group = byType.get(candidate.emergencyType);
    if (group) {
      group.push(candidate);
    } else {
      byType.set(candidate.emergencyType, [candidate]);
    }
  }
  return byType;
}

async function persistDecision(incidentRepository, decision) {
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

/**
 * Una pasada del job: UNA sola query trae los candidatos activos de todos los
 * tipos agrupables, se separan en memoria por emergencyType y cada grupo
 * detectado se persiste. A diferencia de runOnce(), no traga errores.
 *
 * Si algún candidato ya pertenece a un incidente, una segunda query trae los
 * miembros activos de esos incidentes, también los que ya salieron de la
 * ventana: el score de un incidente existente se calcula con todos ellos (ver
 * processEmergencyTypeCandidates).
 */
async function detectIncidents({
  emergencyRepository,
  incidentRepository,
  since,
  radiusMeters,
  minUniqueCitizens,
  emergencyTypes = GROUPABLE_EMERGENCY_TYPES,
}) {
  const candidates = await emergencyRepository.findRecentByType({ emergencyTypes, since });

  const linkedIncidentIds = [...new Set(
    candidates.map((candidate) => candidate.incidentId).filter((incidentId) => incidentId != null)
  )];
  const incidentMembers = linkedIncidentIds.length > 0
    ? await emergencyRepository.findActiveByIncidentIds(linkedIncidentIds)
    : [];

  for (const [emergencyType, typeCandidates] of groupByEmergencyType(candidates)) {
    const decisions = await processEmergencyTypeCandidates(typeCandidates, {
      radiusMeters,
      minUniqueCitizens,
      emergencyType,
      incidentMembers,
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

      await persistDecision(incidentRepository, decision);
    }
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

  let running = false;

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      await withDetectionLock(pool, () => detectIncidents({
        emergencyRepository,
        incidentRepository,
        since: new Date(Date.now() - windowMinutes * 60000),
        radiusMeters,
        minUniqueCitizens,
      }));
    } catch (error) {
      secureLog('error', 'Incident detection job failed', { message: error.message });
    } finally {
      running = false;
    }
  }

  // Primera pasada diferida para no bloquear el boot.
  return schedulePeriodicJob(runOnce, { intervalMs });
}

module.exports = {
  startIncidentDetectionJob,
  withDetectionLock,
  detectIncidents,
  DETECTION_LOCK_KEY,
  GROUPABLE_EMERGENCY_TYPES,
};
