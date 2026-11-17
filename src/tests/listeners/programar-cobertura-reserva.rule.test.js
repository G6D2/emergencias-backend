const { ProgramarCoberturaReservaRule } = require('../../listeners/cobertura-preventiva/reserva-creada/rules/01-programar-cobertura-reserva.rule');

// Payload de ReservaCreada segun register-event-types.ts de Espacios.
function buildContext(data = {}) {
  return {
    data: {
      reservaId: 'res-1',
      tipoReserva: 'ESPACIO',
      recursoId: 'esp-1',
      espacioId: 'esp-1',
      categoria: 'PLAZA',
      zona: 'Palermo',
      latitud: -34.58,
      longitud: -58.42,
      fechaHora: '2099-01-01T18:00:00Z',
      fechaFin: '2099-01-01T23:00:00Z',
      cantidadPersonas: 600,
      cupoMaximo: 1000,
      organizadorId: null,
      createdAt: '2026-11-16T12:00:00Z',
      correlationId: 'res-1',
      ...data,
    },
    metadata: { eventId: 'e1' },
  };
}

describe('ProgramarCoberturaReservaRule', () => {
  const rule = new ProgramarCoberturaReservaRule();
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  describe('appliesTo', () => {
    it('aplica a una reserva de espacio con cantidadPersonas >= 500 (default)', () => {
      expect(rule.appliesTo(buildContext({ cantidadPersonas: 500 }))).toBe(true);
      expect(rule.appliesTo(buildContext({ cantidadPersonas: 3000 }))).toBe(true);
    });

    it('no aplica debajo del umbral ni sin cantidad numerica', () => {
      expect(rule.appliesTo(buildContext({ cantidadPersonas: 499 }))).toBe(false);
      expect(rule.appliesTo(buildContext({ cantidadPersonas: null }))).toBe(false);
      expect(rule.appliesTo(buildContext({ cantidadPersonas: 'muchas' }))).toBe(false);
    });

    it('no aplica a inscripciones a eventos: esas las cubre EVENTO_PUBLICO', () => {
      expect(rule.appliesTo(buildContext({ tipoReserva: 'EVENTO' }))).toBe(false);
      expect(rule.appliesTo(buildContext({ tipoReserva: undefined }))).toBe(false);
    });

    it('no aplica sin reservaId', () => {
      expect(rule.appliesTo(buildContext({ reservaId: '' }))).toBe(false);
      expect(rule.appliesTo(buildContext({ reservaId: 42 }))).toBe(false);
    });

    it('no aplica a una reserva que ya termino (relectura del topic en el primer deploy)', () => {
      expect(rule.appliesTo(buildContext({ fechaFin: '2020-01-01T00:00:00Z' }))).toBe(false);
    });

    it('sin fechaFin legible se cubre igual', () => {
      expect(rule.appliesTo(buildContext({ fechaFin: undefined }))).toBe(true);
      expect(rule.appliesTo(buildContext({ fechaFin: 'no es fecha' }))).toBe(true);
    });

    it('respeta UMBRAL_PERSONAS_COBERTURA_RESERVA y cae al default con un valor invalido', () => {
      process.env.UMBRAL_PERSONAS_COBERTURA_RESERVA = '1000';
      expect(rule.appliesTo(buildContext({ cantidadPersonas: 999 }))).toBe(false);
      expect(rule.appliesTo(buildContext({ cantidadPersonas: 1000 }))).toBe(true);
      process.env.UMBRAL_PERSONAS_COBERTURA_RESERVA = 'basura';
      expect(rule.appliesTo(buildContext({ cantidadPersonas: 500 }))).toBe(true);
    });

    it('no depende del umbral de eventos comunitarios', () => {
      process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA = '5000';
      expect(rule.appliesTo(buildContext({ cantidadPersonas: 600 }))).toBe(true);
    });
  });

  describe('apply', () => {
    it('arma ProgramarCobertura con causa RESERVA y el reservaId como causa', () => {
      expect(rule.apply(buildContext())).toEqual({
        type: 'ProgramarCobertura',
        payload: {
          eventoId: 'res-1',
          causaTipo: 'RESERVA',
          titulo: 'Reserva de espacio (PLAZA)',
          latitud: -34.58,
          longitud: -58.42,
          direccion: null,
          barrio: 'Palermo',
          capacidad: 600,
          correlationId: 'res-1',
        },
      });
    });

    it('sin categoria ni coordenadas', () => {
      const { payload } = rule.apply(buildContext({ categoria: null, latitud: null, longitud: null, zona: null }));
      expect(payload).toMatchObject({ titulo: 'Reserva de espacio', latitud: null, longitud: null, barrio: null });
    });
  });
});
