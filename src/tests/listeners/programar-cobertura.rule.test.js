const { ProgramarCoberturaPreventivaRule } = require('../../listeners/cobertura-preventiva/evento-comunitario-publicado/rules/01-programar-cobertura.rule');

function buildContext(data = {}, metadata = {}) {
  return { data, metadata };
}

describe('ProgramarCoberturaPreventivaRule', () => {
  const rule = new ProgramarCoberturaPreventivaRule();

  describe('appliesTo', () => {
    it('aplica cuando capacidad >= umbral default (500)', () => {
      expect(rule.appliesTo(buildContext({ capacidad: 500 }))).toBe(true);
      expect(rule.appliesTo(buildContext({ capacidad: 1000 }))).toBe(true);
    });

    it('no aplica cuando capacidad < umbral', () => {
      expect(rule.appliesTo(buildContext({ capacidad: 499 }))).toBe(false);
      expect(rule.appliesTo(buildContext({ capacidad: 0 }))).toBe(false);
    });

    it('no aplica cuando capacidad no es numero', () => {
      expect(rule.appliesTo(buildContext({ capacidad: null }))).toBe(false);
      expect(rule.appliesTo(buildContext({ capacidad: 'grande' }))).toBe(false);
      expect(rule.appliesTo(buildContext({}))).toBe(false);
    });

    it('respeta UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA del env', () => {
      const original = process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA;
      process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA = '200';
      try {
        expect(rule.appliesTo(buildContext({ capacidad: 200 }))).toBe(true);
        expect(rule.appliesTo(buildContext({ capacidad: 199 }))).toBe(false);
      } finally {
        process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA = original;
      }
    });

    it('env invalido cae al default 500', () => {
      const original = process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA;
      process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA = 'basura';
      try {
        expect(rule.appliesTo(buildContext({ capacidad: 500 }))).toBe(true);
        expect(rule.appliesTo(buildContext({ capacidad: 499 }))).toBe(false);
      } finally {
        process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA = original;
      }
    });
  });

  describe('apply', () => {
    it('devuelve type ProgramarCobertura con los campos del evento', () => {
      const context = buildContext(
        { nombre: 'Feria del Libro', latitud: -34.6, longitud: -58.4, capacidad: 1500 },
        { eventId: 'evt-123' }
      );
      const outcome = rule.apply(context);

      expect(outcome.type).toBe('ProgramarCobertura');
      expect(outcome.payload).toEqual({
        nombre: 'Feria del Libro',
        latitud: -34.6,
        longitud: -58.4,
        capacidad: 1500,
        causationEventId: 'evt-123',
      });
    });

    it('lat/lng null cuando no son numeros', () => {
      const outcome = rule.apply(buildContext(
        { nombre: 'Evento sin coord', latitud: null, longitud: undefined, capacidad: 600 },
        { eventId: 'evt-456' }
      ));

      expect(outcome.payload.latitud).toBeNull();
      expect(outcome.payload.longitud).toBeNull();
    });

    it('nombre default cuando no viene', () => {
      const outcome = rule.apply(buildContext({ capacidad: 600 }, { eventId: 'evt-789' }));
      expect(outcome.payload.nombre).toBe('Evento comunitario');
    });
  });
});
