const {
  SEVERITY_LEVELS,
  compareSeverity,
  isValidSeverity,
  normalizeSeverity,
} = require('../domain/severity');

describe('severity domain', () => {
  it('orders severity from low to critical', () => {
    expect(SEVERITY_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
    expect(compareSeverity('critical', 'low')).toBeGreaterThan(0);
    expect(compareSeverity('medium', 'high')).toBeLessThan(0);
  });

  it('validates and defaults severity', () => {
    expect(isValidSeverity('high')).toBe(true);
    expect(isValidSeverity('urgent-now')).toBe(false);
    expect(normalizeSeverity(undefined)).toBe('critical');
    expect(normalizeSeverity('urgent-now')).toBeNull();
  });
});