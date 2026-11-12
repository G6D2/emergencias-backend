const SEVERITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

function isValidSeverity(value) {
  return typeof value === 'string' && SEVERITY_LEVELS.includes(value);
}

function normalizeSeverity(value, defaultValue = 'critical') {
  const severity = value === undefined ? defaultValue : value;
  if (!isValidSeverity(severity)) {
    return null;
  }
  return severity;
}

function compareSeverity(left, right) {
  return SEVERITY_LEVELS.indexOf(left) - SEVERITY_LEVELS.indexOf(right);
}

// Decisión de producto: la severidad no la elige quien reporta. El backend la
// deriva del emergencyType (catálogo cerrado en src/domain/emergency-type.js);
// cualquier `severity` que mande el cliente se ignora. Esta tabla es la base
// sobre la que el Risk Engine (src/domain/risk-engine.js, en main vía #36)
// solo puede subir la prioridad, nunca bajarla.
const SEVERITY_BY_TYPE = Object.freeze({
  PANICO: 'critical',
  MEDICA: 'high',
  INCENDIO: 'high',
  DISTURBIO_EVENTO_MASIVO: 'medium',
  INFRAESTRUCTURA: 'medium',
  OTRO: 'low',
  PREVENTIVA: 'low',
  TRANSITO: 'medium',
});

/**
 * Severidad derivada para un emergencyType canónico. Se asume que `type` ya
 * pasó por assertEmergencyType/normalizeEmergencyType; un tipo fuera de la
 * tabla (no debería ocurrir) degrada a 'low' en vez de romper la creación.
 */
function severityForType(type) {
  return SEVERITY_BY_TYPE[type] || 'low';
}

/**
 * Prioridad efectiva de una emergencia (tarea #63/visibilidad del motor de
 * incidentes): el máximo entre su severity individual y la priority del
 * incidente al que pertenece, si pertenece a alguno. Mismo criterio que
 * risk-engine.applyPriorityInvariant: la prioridad agrupada nunca puede bajar
 * la de una emergencia individual, pero sin lanzar si incidentPriority es
 * null/undefined: acá "todavía sin incidente" es el caso normal (la mayoría
 * de las emergencias), no un dato corrupto.
 * @param {'low'|'medium'|'high'|'critical'} severity
 * @param {'low'|'medium'|'high'|'critical'|null|undefined} incidentPriority
 * @returns {'low'|'medium'|'high'|'critical'}
 */
function effectivePriority(severity, incidentPriority) {
  if (!incidentPriority || !SEVERITY_LEVELS.includes(incidentPriority)) return severity;
  return compareSeverity(incidentPriority, severity) > 0 ? incidentPriority : severity;
}

/**
 * Prioridad de despacho (ADR "Elevar temporalmente la prioridad con contextos
 * de zona"): la prioridad efectiva más un nivel si hay un contexto de zona
 * vigente en el barrio de la emergencia, con tope en `critical`. Varios
 * contextos a la vez suben un solo nivel. No se guarda: se calcula al leer,
 * con la misma regla que el ORDER BY de EmergencyRepository.findPage.
 * @param {'low'|'medium'|'high'|'critical'} priority prioridad efectiva
 * @param {boolean} hasZoneContext
 * @returns {'low'|'medium'|'high'|'critical'}
 */
function dispatchPriority(priority, hasZoneContext) {
  const index = SEVERITY_LEVELS.indexOf(priority);
  if (!hasZoneContext || index === -1) return priority;
  return SEVERITY_LEVELS[Math.min(index + 1, SEVERITY_LEVELS.length - 1)];
}

module.exports = {
  SEVERITY_LEVELS,
  isValidSeverity,
  normalizeSeverity,
  compareSeverity,
  SEVERITY_BY_TYPE,
  severityForType,
  effectivePriority,
  dispatchPriority,
};