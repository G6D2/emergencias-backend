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

module.exports = {
  SEVERITY_LEVELS,
  isValidSeverity,
  normalizeSeverity,
  compareSeverity,
  SEVERITY_BY_TYPE,
  severityForType,
};