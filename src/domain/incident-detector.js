// Orquestación pura del rule-based grouping + scoring (tarea #60, parte 2/2).
// Módulo de dominio: no conoce Postgres ni Kafka. Recibe candidatos ya
// traídos por EmergencyRepository.findRecentByType y devuelve decisiones
// para que el job (incident-detection-job.js) las persista.

const { groupNearbyEmergencies, haversineDistanceMeters } = require('./rule-based-grouper');
const { calculateIncidentScore, scoreToPriority, applyPriorityInvariant } = require('./risk-engine');
const { compareSeverity } = require('./severity');
const { detectGroups } = require('./incident-detection-strategy');

const ALGORITHM_VERSION = 'rule-based-v1';

function pairwiseDistances(members) {
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
 * @param {Array<{ id: string, correlationId: string, userId: string, latitude: number, longitude: number, createdAt: string|Date, severity: string, incidentId: string|null }>} candidates
 * @param {{ radiusMeters: number, minUniqueCitizens: number, emergencyType: string }} options
 * @returns {Promise<Array<object>>} decisiones, una por grupo detectado
 */
async function processEmergencyTypeCandidates(candidates, { radiusMeters, minUniqueCitizens, emergencyType }) {
  // groupNearbyEmergencies identifica cada candidato por emergencyId; los
  // candidatos de findRecentByType usan id (ver discrepancia resuelta con Mati).
  const withEmergencyId = candidates.map((candidate) => ({ ...candidate, emergencyId: candidate.id }));
  // Selección de estrategia (#61, parte 1/2, ADR-002): por ahora primary y
  // fallback son la MISMA función (groupNearbyEmergencies) -- DbscanGrouper
  // todavía no existe, es la parte 2/2 en esta misma rama. Esto es
  // intencional, no un error: deja la infraestructura de selección lista y
  // funcionando exactamente igual que antes (mismo comportamiento
  // observable), sin introducir DBSCAN todavía.
  const groups = await detectGroups(
    withEmergencyId,
    { radiusMeters, minUniqueCitizens },
    {
      primary: groupNearbyEmergencies,
      fallback: groupNearbyEmergencies,
    }
  );
  const candidatesByEmergencyId = new Map(withEmergencyId.map((c) => [c.emergencyId, c]));

  const decisions = [];

  for (const emergencyIds of groups) {
    const members = emergencyIds.map((emergencyId) => candidatesByEmergencyId.get(emergencyId));

    const existingIncidentIds = new Set(
      members.map((member) => member.incidentId).filter((incidentId) => incidentId != null)
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
      algorithmVersion: ALGORITHM_VERSION,
      skippedReason: null,
    });
  }

  return decisions;
}

module.exports = { processEmergencyTypeCandidates, ALGORITHM_VERSION };
