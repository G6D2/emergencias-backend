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
// sobre la que el Risk Engine (branch de Mati, feature/incident-detection-rule-based)
// solo puede subir la prioridad, nunca bajarla.
const SEVERITY_BY_TYPE = Object.freeze({
  PANICO: 'critical',
  MEDICA: 'high',
  INCENDIO: 'high',
  DISTURBIO_EVENTO_MASIVO: 'medium',
  INFRAESTRUCTURA: 'medium',
  OTRO: 'low',
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
 * risk-engine.applyPriorityInvariant (branch feature/incident-detection-rule-based:
 * la prioridad agrupada nunca puede bajar la de una emergencia individual),
 * pero sin lanzar si incidentPriority es null/undefined: acá "todavía sin
 * incidente" es el caso normal (la mayoría de las emergencias), no un dato
 * corrupto.
 * @param {'low'|'medium'|'high'|'critical'} severity
 * @param {'low'|'medium'|'high'|'critical'|null|undefined} incidentPriority
 * @returns {'low'|'medium'|'high'|'critical'}
 */
function effectivePriority(severity, incidentPriority) {
  if (!incidentPriority || !SEVERITY_LEVELS.includes(incidentPriority)) return severity;
  return compareSeverity(incidentPriority, severity) > 0 ? incidentPriority : severity;
}

module.exports = {
  SEVERITY_LEVELS,
  isValidSeverity,
  normalizeSeverity,
  compareSeverity,
  SEVERITY_BY_TYPE,
  severityForType,
  effectivePriority,
};