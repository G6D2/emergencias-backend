const {
  EMERGENCY_TYPES,
  EMERGENCY_TYPE_ALIASES,
  normalizeEmergencyType,
  assertEmergencyType,
} = require('../domain/emergency-type');

describe('emergency-type domain', () => {
  it('expone el catálogo cerrado en español mayúsculas, congelado', () => {
    expect(EMERGENCY_TYPES).toEqual([
      'MEDICA',
      'INCENDIO',
      'INFRAESTRUCTURA',
      'DISTURBIO_EVENTO_MASIVO',
      'OTRO',
      'PANICO',
      'PREVENTIVA',
      'TRANSITO',
    ]);
    expect(Object.isFrozen(EMERGENCY_TYPES)).toBe(true);
    expect(() => EMERGENCY_TYPES.push('HACK')).toThrow();
  });

  it('todos los alias del front apuntan a un valor del catálogo', () => {
    Object.values(EMERGENCY_TYPE_ALIASES).forEach((canonical) => {
      expect(EMERGENCY_TYPES).toContain(canonical);
    });
  });

  describe('normalizeEmergencyType', () => {
    it.each([
      ['panic', 'PANICO'],
      ['medical', 'MEDICA'],
      ['fire', 'INCENDIO'],
      ['infrastructure', 'INFRAESTRUCTURA'],
      ['disturbance', 'DISTURBIO_EVENTO_MASIVO'],
      ['other', 'OTRO'],
    ])('mapea el alias del front %s → %s', (alias, canonical) => {
      expect(normalizeEmergencyType(alias)).toBe(canonical);
    });

    it.each([
      ['MEDICA', 'MEDICA'],
      ['medica', 'MEDICA'],
      ['Incendio', 'INCENDIO'],
      ['disturbio_evento_masivo', 'DISTURBIO_EVENTO_MASIVO'],
      ['Panico', 'PANICO'],
      ['otro', 'OTRO'],
    ])('acepta el canónico en cualquier casing: %s → %s', (input, canonical) => {
      expect(normalizeEmergencyType(input)).toBe(canonical);
    });

    it('acepta alias con casing mixto y espacios alrededor', () => {
      expect(normalizeEmergencyType('  fire ')).toBe('INCENDIO');
      expect(normalizeEmergencyType('Medical')).toBe('MEDICA');
      expect(normalizeEmergencyType('\tINCENDIO\n')).toBe('INCENDIO');
    });

    it.each([
      ['robbery'],
      ['MEDICAL_EMERGENCY'],
      ['INCENDI'],
      [''],
      ['   '],
    ])('devuelve null para el valor inválido %p', (input) => {
      expect(normalizeEmergencyType(input)).toBeNull();
    });

    it('devuelve null para null, undefined y no-strings', () => {
      expect(normalizeEmergencyType(null)).toBeNull();
      expect(normalizeEmergencyType(undefined)).toBeNull();
      expect(normalizeEmergencyType(42)).toBeNull();
      expect(normalizeEmergencyType({ type: 'fire' })).toBeNull();
      expect(normalizeEmergencyType(['fire'])).toBeNull();
    });
  });

  describe('assertEmergencyType', () => {
    it('devuelve null si el valor está ausente (el caller decide el default)', () => {
      expect(assertEmergencyType(undefined)).toBeNull();
      expect(assertEmergencyType(null)).toBeNull();
      expect(assertEmergencyType('')).toBeNull();
      expect(assertEmergencyType('   ')).toBeNull();
    });

    it('normaliza un valor válido', () => {
      expect(assertEmergencyType('fire')).toBe('INCENDIO');
      expect(assertEmergencyType('medica')).toBe('MEDICA');
    });

    it('lanza ValidationError (400) listando los valores válidos', () => {
      expect(() => assertEmergencyType('flood')).toThrow(expect.objectContaining({
        name: 'ValidationError',
        statusCode: 400,
      }));
      expect(() => assertEmergencyType('flood')).toThrow(
        'MEDICA, INCENDIO, INFRAESTRUCTURA, DISTURBIO_EVENTO_MASIVO, OTRO, PANICO, PREVENTIVA'
      );
      expect(() => assertEmergencyType(42)).toThrow(/Invalid emergencyType/);
    });
  });
});
