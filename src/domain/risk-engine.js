// Risk Engine determinístico (tarea #60, parte 1/2). Módulo puro: no conoce
// Postgres ni Kafka. Calcula el score/prioridad de un incidente a partir de
// features ya calculadas por quien lo llama (conteos, distancias, recencia).

// TEMPORAL: escala duplicada de severity (ver V7__add_severity_enum_check.sql).
// Reemplazar por domain/severity.js cuando el PR de nomenclatura (#45,
// actualmente PR #17) se mergee. No renombrar sin coordinar: max() entre
// priorityIndividual e incidentPriority depende de que ambas compartan
// exactamente esta escala.
const PRIORITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

// Umbrales y pesos de scoring: son un punto de partida razonable para
// iterar con datos reales, NO están fijados por el issue #60 — calibrables.
const MULTI_REPORT_THRESHOLD = 3; // reportes a partir de los cuales se deja de ver como un caso aislado
const UNIQUE_CITIZENS_THRESHOLD = 2; // ciudadanos distintos a partir de los cuales se descarta que sea la misma persona reportando varias veces
const PROXIMITY_CLUSTER_METERS = 100; // distancia máxima entre reportes para considerarlos el mismo evento físico
const RECENCY_WINDOW_MINUTES = 15; // ventana en la que un reporte se considera "reciente" y suma más peso

const MAX_SCORED_REPORTS = 10; // tope de reportes que siguen sumando score (evita que un spam de reportes domine el cálculo)
const MAX_SCORED_UNIQUE_CITIZENS = 10; // ídem para ciudadanos distintos

const REPORT_COUNT_WEIGHT = 5;
const UNIQUE_CITIZEN_WEIGHT = 8;
const PROXIMITY_WEIGHT = 20;
const RECENCY_WEIGHT = 15;
const SEVERITY_SCORE = Object.freeze({ low: 0, medium: 10, high: 20, critical: 30 });

const PRIORITY_SCORE_THRESHOLDS = Object.freeze({
  critical: 80,
  high: 50,
  medium: 20,
});

/**
 * Calcula el score de un incidente y los reasonCodes que explican por qué.
 * Cada factor suma de forma continua y acotada (nunca negativo, nunca sin
 * tope) para que ningún input extremo domine el resultado por sí solo.
 *
 * @param {object} input
 * @param {number} input.reportCount - cantidad de reportes agrupados
 * @param {number} input.uniqueCitizenCount - ciudadanos distintos entre esos reportes
 * @param {number} [input.minDistanceMeters] - distancia mínima entre reportes del grupo
 * @param {number} [input.maxDistanceMeters] - distancia máxima entre reportes del grupo
 * @param {number} input.recencyMinutes - minutos desde el reporte más reciente (menor = más reciente)
 * @param {'low'|'medium'|'high'|'critical'} [input.maxSeverity] - severity individual más alta del grupo
 * @returns {{ score: number, reasonCodes: string[] }}
 */
function calculateIncidentScore({
  reportCount,
  uniqueCitizenCount,
  minDistanceMeters,
  maxDistanceMeters,
  recencyMinutes,
  maxSeverity,
}) {
  const reasonCodes = [];
  let score = 0;

  // Más reportes del mismo tipo/zona bajan la probabilidad de falso positivo.
  score += Math.min(reportCount, MAX_SCORED_REPORTS) * REPORT_COUNT_WEIGHT;
  if (reportCount >= MULTI_REPORT_THRESHOLD) {
    reasonCodes.push('MULTI_REPORT_THRESHOLD');
  }

  // Ciudadanos distintos descartan que sea la misma persona reportando repetidamente.
  score += Math.min(uniqueCitizenCount, MAX_SCORED_UNIQUE_CITIZENS) * UNIQUE_CITIZEN_WEIGHT;
  if (uniqueCitizenCount >= UNIQUE_CITIZENS_THRESHOLD) {
    reasonCodes.push('UNIQUE_CITIZENS_THRESHOLD');
  }

  // Cuanto más cerca entre sí los reportes, más probable que sea el mismo evento físico.
  // Contribución continua (no un escalón): más cerca siempre puntúa igual o más.
  const effectiveDistance = maxDistanceMeters ?? minDistanceMeters;
  if (Number.isFinite(effectiveDistance)) {
    const proximityRatio = Math.max(0, 1 - effectiveDistance / PROXIMITY_CLUSTER_METERS);
    score += PROXIMITY_WEIGHT * proximityRatio;
    if (effectiveDistance <= PROXIMITY_CLUSTER_METERS) {
      reasonCodes.push('PROXIMITY_CLUSTER');
    }
  }

  // Reportes más recientes pesan más que reportes dispersos en el tiempo.
  // Contribución continua: fuera de la ventana no resta, solo deja de sumar.
  if (Number.isFinite(recencyMinutes)) {
    const recencyRatio = Math.max(0, 1 - recencyMinutes / RECENCY_WINDOW_MINUTES);
    score += RECENCY_WEIGHT * recencyRatio;
  }

  score += SEVERITY_SCORE[maxSeverity] || 0;

  return { score: Math.round(score), reasonCodes };
}

/**
 * Mapea un score numérico a uno de PRIORITY_LEVELS. Siempre devuelve un
 * valor del catálogo, incluso para scores negativos o fuera de rango.
 * @param {number} score
 * @returns {'low'|'medium'|'high'|'critical'}
 */
function scoreToPriority(score) {
  if (score >= PRIORITY_SCORE_THRESHOLDS.critical) return 'critical';
  if (score >= PRIORITY_SCORE_THRESHOLDS.high) return 'high';
  if (score >= PRIORITY_SCORE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/**
 * Invariante de seguridad: la prioridad efectiva nunca puede ser menor a la
 * que ya tenía la emergencia individualmente, aunque el cálculo del
 * incidente agrupado dé un score más bajo (p. ej. por diluirse entre varios
 * reportes de severity baja).
 * @param {'low'|'medium'|'high'|'critical'} priorityIndividual
 * @param {'low'|'medium'|'high'|'critical'} incidentPriority
 * @returns {'low'|'medium'|'high'|'critical'}
 */
function applyPriorityInvariant(priorityIndividual, incidentPriority) {
  const indexIndividual = PRIORITY_LEVELS.indexOf(priorityIndividual);
  const indexIncident = PRIORITY_LEVELS.indexOf(incidentPriority);

  if (indexIndividual === -1) {
    throw new Error(`Invalid priorityIndividual: ${String(priorityIndividual)}`);
  }
  if (indexIncident === -1) {
    throw new Error(`Invalid incidentPriority: ${String(incidentPriority)}`);
  }

  return PRIORITY_LEVELS[Math.max(indexIndividual, indexIncident)];
}

module.exports = {
  PRIORITY_LEVELS,
  calculateIncidentScore,
  scoreToPriority,
  applyPriorityInvariant,
};
