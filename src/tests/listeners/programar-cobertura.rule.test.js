const { ProgramarCoberturaPreventivaRule } = require('../../listeners/cobertura-preventiva/evento-comunitario-publicado/rules/01-programar-cobertura.rule');

function buildContext(data = {}, metadata = {}) {
  return { data: { eventoId: 'ev-1', ...data }, metadata };
}

describe('ProgramarCoberturaPreventivaRule', () => {
  const rule = new ProgramarCoberturaPreventivaRule();

  describe('appliesTo', () => {
    it('aplica cuando capacidad >= umbral default (500)', () => {
      expect(rule.appliesTo(buildContext({ capacidad: 500 }))).toBe(true);
      expect(rule.appliesTo(buildContext({ capacidad: 1000 }))).toBe(true);
    });

    it('usa cupoMaximo si no viene capacidad', () => {
      expect(rule.appliesTo(buildContext({ cupoMaximo: 700 }))).toBe(true);
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

    it('no aplica sin eventoId ni con el evento ya cancelado', () => {
      expect(rule.appliesTo({ data: { capacidad: 800 }, metadata: {} })).toBe(false);
      expect(rule.appliesTo(buildContext({ capacidad: 800, estado: 'CANCELLED' }))).toBe(false);
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
    it('devuelve ProgramarCobertura con los campos que manda Espacios', () => {
      const outcome = rule.apply(buildContext({
        titulo: 'Feria del Libro',
        latitud: -34.6,
        longitud: -58.4,
        direccion: 'Av. Sarmiento 2704',
        capacidad: 800,
        correlationId: 'evento-ev-1',
      }, { eventId: 'evt-123' }));

      expect(outcome).toEqual({
        type: 'ProgramarCobertura',
        payload: {
          eventoId: 'ev-1',
          titulo: 'Feria del Libro',
          latitud: -34.6,
          longitud: -58.4,
          direccion: 'Av. Sarmiento 2704',
          capacidad: 800,
          correlationId: 'evento-ev-1',
        },
      });
    });

    it('titulo default y coordenadas null cuando no vienen', () => {
      const { payload } = rule.apply(buildContext({ capacidad: 600, latitud: '-34' }));
      expect(payload.titulo).toBe('Evento comunitario');
      expect(payload.latitud).toBeNull();
      expect(payload.longitud).toBeNull();
      expect(payload.direccion).toBeNull();
      expect(payload.correlationId).toBeNull();
    });
  });
});
