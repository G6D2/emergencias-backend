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

module.exports = { SEVERITY_LEVELS, isValidSeverity, normalizeSeverity, compareSeverity };