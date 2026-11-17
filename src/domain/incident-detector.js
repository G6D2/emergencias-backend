// Orquestación pura del rule-based grouping + scoring (tarea #60, parte 2/2).
// Módulo de dominio: no conoce Postgres ni Kafka. Recibe candidatos ya
// traídos por EmergencyRepository.findRecentByType y devuelve decisiones
// para que el job (incident-detection-job.js) las persista.

const { groupNearbyEmergencies, haversineDistanceMeters } = require('./rule-based-grouper');
const { groupNearbyEmergenciesDbscan } = require('./dbscan-grouper');
const { calculateIncidentScore, scoreToPriority, applyPriorityInvariant } = require('./risk-engine');
const { compareSeverity } = require('./severity');
const { detectGroups } = require('./incident-detection-strategy');

const RULE_BASED_ALGORITHM_VERSION = 'rule-based-v1';
const DBSCAN_ALGORITHM_VERSION = 'dbscan-v1';

function hasLocation(member) {
  return Number.isFinite(member.latitude) && Number.isFinite(member.longitude);
}

// Un miembro sin ubicación (fila legacy o anonimizada) cuenta como reporte,
// pero no entra en las distancias: Haversine lo tomaría como si estuviera en
// (0, 0) y la cercanía del incidente se iría a cero.
function pairwiseDistances(allMembers) {
  const members = allMembers.filter(hasLocation);
  if (members.length < 2) {
    return { minDistanceMeters: 0, maxDistanceMeters: 0 };
  }

  let minDistanceMeters = Infinity;
  let maxDistanceMeters = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const distance = haversineDistanceMeters(members[i], members[j]);
      minDistanceMeters = Math.min(minDistanceMeters, distance);
      maxDistanceMeters = Math.max(maxDistanceMeters, distance);
    }
  }
  return { minDistanceMeters, maxDistanceMeters };
}

// Suma al grupo de DBSCAN los demás miembros activos del incidente: los que
// ya salieron de la ventana (o que esta pasada no cayeron en el grupo). Sin
// repetir: si un miembro viene en los dos lados, queda el del grupo.
function withActiveIncidentMembers(groupMembers, activeIncidentMembers) {
  const byEmergencyId = new Map(groupMembers.map((member) => [member.emergencyId, member]));
  for (const member of activeIncidentMembers) {
    if (!byEmergencyId.has(member.emergencyId)) {
      byEmergencyId.set(member.emergencyId, member);
    }
  }
  return [...byEmergencyId.values()];
}

function indexByIncidentId(incidentMembers) {
  const byIncidentId = new Map();
  for (const member of incidentMembers) {
    const list = byIncidentId.get(member.incidentId) || [];
    list.push({ ...member, emergencyId: member.id });
    byIncidentId.set(member.incidentId, list);
  }
  return byIncidentId;
}

function newestCreatedAtMinutesAgo(members) {
  const newestTimestamp = members.reduce((latest, member) => {
    const time = new Date(member.createdAt).getTime();
    return time > latest ? time : latest;
  }, -Infinity);
  return (Date.now() - newestTimestamp) / 60000;
}

function maxSeverityOf(members) {
  return members.reduce(
    (max, member) => (compareSeverity(member.severity, max) > 0 ? member.severity : max),
    members[0].severity
  );
}

/**
 * Agrupa candidatos de un mismo emergencyType y calcula, por grupo válido,
 * una decisión de scoring lista para persistir. No toca la base de datos.
 *
 * La ventana (los candidatos) decide la membresía: qué reportes forman un
 * grupo nuevo y cuáles se suman a un incidente. El score de un incidente que
 * ya existe se calcula con todos sus miembros activos (`incidentMembers`),
 * también los que ya salieron de la ventana: que un reporte cumpla
 * INCIDENT_WINDOW_MIN no le baja el score ni la prioridad. Uno que pasa a un
 * estado terminal sí deja de contar (no viene ni en los candidatos ni en
 * `incidentMembers`).
 *
 * @param {Array<{ id: string, correlationId: string, userId: string, latitude: number, longitude: number, createdAt: string|Date, severity: string, incidentId: string|null }>} candidates
 * @param {{ radiusMeters: number, minUniqueCitizens: number, emergencyType: string, incidentMembers?: Array<object> }} options
 *   `incidentMembers`: miembros activos de los incidentes ya vinculados a
 *   algún candidato, con el mismo formato que los candidatos.
 * @returns {Promise<Array<object>>} decisiones, una por grupo detectado
 */
async function processEmergencyTypeCandidates(candidates, {
  radiusMeters,
  minUniqueCitizens,
  emergencyType,
  incidentMembers = [],
}) {
  // groupNearbyEmergencies identifica cada candidato por emergencyId; los
  // candidatos de findRecentByType usan id (ver discrepancia resuelta con Mati).
  const withEmergencyId = candidates.map((candidate) => ({ ...candidate, emergencyId: candidate.id }));
  // Selección de estrategia (#61, ADR-002): DbscanGrouper es la primaria;
  // RuleBasedGrouper queda como fallback ante una falla técnica real de
  // DBSCAN (Caso A). Si DBSCAN corre bien y no encuentra cluster, esa
  // respuesta vacía se respeta tal cual (Caso B) -- detectGroups() nunca
  // cae a fallback por un resultado vacío, solo por excepción.
  const { groups, strategy } = await detectGroups(
    withEmergencyId,
    { radiusMeters, minUniqueCitizens },
    {
      primary: groupNearbyEmergenciesDbscan,
      fallback: groupNearbyEmergencies,
    }
  );
  const algorithmVersion = strategy === 'fallback' ? RULE_BASED_ALGORITHM_VERSION : DBSCAN_ALGORITHM_VERSION;
  const candidatesByEmergencyId = new Map(withEmergencyId.map((c) => [c.emergencyId, c]));
  const activeMembersByIncidentId = indexByIncidentId(incidentMembers);

  const decisions = [];

  for (const emergencyIds of groups) {
    const groupMembers = emergencyIds.map((emergencyId) => candidatesByEmergencyId.get(emergencyId));

    const existingIncidentIds = new Set(
      groupMembers.map((member) => member.incidentId).filter((incidentId) => incidentId != null)
    );

    if (existingIncidentIds.size > 1) {
      decisions.push({
        incidentId: null,
        emergencyType,
        members: [],
        factors: null,
        priority: null,
        score: null,
        reasonCodes: null,
        algorithmVersion: null,
        skippedReason: 'AMBIGUOUS_EXISTING_INCIDENTS',
        conflictingIncidentIds: [...existingIncidentIds],
      });
      continue;
    }

    const incidentId = existingIncidentIds.size === 1 ? [...existingIncidentIds][0] : null;
    // Incidente existente: se puntúa con todos sus miembros activos, no solo
    // con los que siguen en la ventana. Así también reciben la
    // EmergenciaPriorizada si la prioridad cambia.
    const members = incidentId == null
      ? groupMembers
      : withActiveIncidentMembers(groupMembers, activeMembersByIncidentId.get(incidentId) || []);

    const { minDistanceMeters, maxDistanceMeters } = pairwiseDistances(members);
    const factors = {
      reportCount: members.length,
      uniqueCitizenCount: new Set(members.map((member) => member.userId)).size,
      minDistanceMeters,
      maxDistanceMeters,
      recencyMinutes: newestCreatedAtMinutesAgo(members),
      maxSeverity: maxSeverityOf(members),
    };

    const { score, reasonCodes } = calculateIncidentScore(factors);
    const incidentPriority = scoreToPriority(score);

    const decisionMembers = members.map((member) => ({
      emergencyId: member.emergencyId,
      correlationId: member.correlationId,
      priorityIndividual: member.severity,
      finalPriority: applyPriorityInvariant(member.severity, incidentPriority),
      // Campo extra (no pedido en el contrato original de 4 campos): el job
      // lo usa para no llamar addMember sobre miembros que ya estaban
      // vinculados a este mismo incidentId. member.incidentId != null es
      // necesario: si ambos son null (incidente nuevo), == daria un falso
      // "ya vinculado" y el job nunca llamaria addMember.
      alreadyLinked: member.incidentId != null && member.incidentId === incidentId,
    }));

    decisions.push({
      incidentId,
      emergencyType,
      members: decisionMembers,
      factors,
      priority: incidentPriority,
      score,
      reasonCodes,
      algorithmVersion,
      skippedReason: null,
    });
  }

  return decisions;
}

module.exports = { processEmergencyTypeCandidates, RULE_BASED_ALGORITHM_VERSION, DBSCAN_ALGORITHM_VERSION };
