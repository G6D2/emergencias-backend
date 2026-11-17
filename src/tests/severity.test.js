const {
  SEVERITY_LEVELS,
  compareSeverity,
  isValidSeverity,
  severityForType,
  SEVERITY_BY_TYPE,
  effectivePriority,
} = require('../domain/severity');
const { EMERGENCY_TYPES } = require('../domain/emergency-type');

describe('severity domain', () => {
  it('orders severity from low to critical', () => {
    expect(SEVERITY_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
    expect(compareSeverity('critical', 'low')).toBeGreaterThan(0);
    expect(compareSeverity('medium', 'high')).toBeLessThan(0);
  });

  it('validates severity', () => {
    expect(isValidSeverity('high')).toBe(true);
    expect(isValidSeverity('urgent-now')).toBe(false);
  });
});

// Decisión de producto: "la severidad no la elige quien reporta". El backend
// la deriva del emergencyType; esta es la tabla acordada con el PM (base
// sobre la que el Risk Engine solo puede subir la prioridad, nunca bajarla).
describe('severityForType', () => {
  it.each([
    ['PANICO', 'critical'],
    ['MEDICA', 'high'],
    ['INCENDIO', 'high'],
    ['DISTURBIO_EVENTO_MASIVO', 'medium'],
    ['INFRAESTRUCTURA', 'medium'],
    ['OTRO', 'low'],
  ])('%s -> %s', (type, expectedSeverity) => {
    expect(severityForType(type)).toBe(expectedSeverity);
  });

  it('covers every canonical emergencyType with a valid severity', () => {
    EMERGENCY_TYPES.forEach((type) => {
      expect(SEVERITY_BY_TYPE).toHaveProperty(type);
      expect(isValidSeverity(severityForType(type))).toBe(true);
    });
  });

  it('degrades to low for an unmapped type instead of throwing', () => {
    expect(severityForType('UNKNOWN')).toBe('low');
    expect(severityForType(undefined)).toBe('low');
  });
});

describe('effectivePriority', () => {
  it('sin incidente (null/undefined), la efectiva es la propia severity', () => {
    expect(effectivePriority('medium', null)).toBe('medium');
    expect(effectivePriority('high', undefined)).toBe('high');
  });

  it('un incidentPriority no reconocido se ignora (degrada a la severity individual, no lanza)', () => {
    expect(effectivePriority('medium', 'no-existe')).toBe('medium');
  });

  it('devuelve incidentPriority cuando es mayor que severity', () => {
    expect(effectivePriority('low', 'critical')).toBe('critical');
  });

  it('devuelve severity cuando es mayor o igual que incidentPriority (nunca baja)', () => {
    expect(effectivePriority('critical', 'low')).toBe('critical');
    expect(effectivePriority('high', 'high')).toBe('high');
  });
});