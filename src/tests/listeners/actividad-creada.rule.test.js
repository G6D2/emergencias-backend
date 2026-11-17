const { ProgramarCoberturaActividadRule } = require(
  '../../listeners/cobertura-preventiva/actividad-creada/rules/01-programar-cobertura.rule'
);

const buildContext = (data) => ({ metadata: { eventId: 'e1' }, data });
const actividad = (extra = {}) => ({
  actividadId: 'act-7',
  titulo: 'Festival de Primavera',
  capacidad: 1200,
  estado: 'PROGRAMADA',
  direccion: 'Av. Cordoba 2100',
  correlationId: 'act-7',
  ubicacion: { lat: -34.5994, lng: -58.3988 },
  fechaHoraInicio: Date.now() + 60 * 60 * 1000,
  fechaHoraFinalizacion: Date.now() + 3 * 60 * 60 * 1000,
  ...extra,
});

describe('listeners/cobertura-preventiva ProgramarCoberturaActividadRule', () => {
  const rule = new ProgramarCoberturaActividadRule();
  const original = process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA;

  beforeEach(() => {
    delete process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA;
    else process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA = original;
  });

  describe('appliesTo', () => {
    it('aplica desde 500 personas (umbral default)', () => {
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 500 })))).toBe(true);
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 1200 })))).toBe(true);
    });

    it('no aplica por debajo del umbral', () => {
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 499 })))).toBe(false);
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 0 })))).toBe(false);
    });

    it('no aplica sin capacidad numerica ni con capacidad no finita', () => {
      expect(rule.appliesTo(buildContext(actividad({ capacidad: undefined })))).toBe(false);
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 'muchos' })))).toBe(false);
    });

    it('no aplica sin actividadId', () => {
      expect(rule.appliesTo(buildContext(actividad({ actividadId: undefined })))).toBe(false);
      expect(rule.appliesTo(buildContext(actividad({ actividadId: '' })))).toBe(false);
      expect(rule.appliesTo({ metadata: {}, data: undefined })).toBe(false);
    });

    it('no aplica a una actividad ya cancelada', () => {
      expect(rule.appliesTo(buildContext(actividad({ estado: 'CANCELADA' })))).toBe(false);
    });

    it('no aplica a una actividad que ya termino (fechaHoraFinalizacion en el pasado)', () => {
      const pasado = Date.now() - 60 * 1000;
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: pasado })))).toBe(false);
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: new Date(pasado) })))).toBe(false);
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: new Date(pasado).toISOString() })))).toBe(false);
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: String(pasado) })))).toBe(false);
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: BigInt(pasado) })))).toBe(false);
    });

    it('aplica a una actividad en curso o futura y a la que no trae fecha de fin', () => {
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: Date.now() + 1000 })))).toBe(true);
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: undefined })))).toBe(true);
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: null })))).toBe(true);
      expect(rule.appliesTo(buildContext(actividad({ fechaHoraFinalizacion: 'no-es-fecha' })))).toBe(true);
    });

    it('no aplica a reservas de ciudadanos (organizadorTipo CIUDADANO)', () => {
      expect(rule.appliesTo(buildContext(actividad({ organizadorTipo: 'CIUDADANO' })))).toBe(false);
    });

    it('aplica si el organizador es la CIUDAD o no viene organizadorTipo', () => {
      expect(rule.appliesTo(buildContext(actividad({ organizadorTipo: 'CIUDAD' })))).toBe(true);
      expect(rule.appliesTo(buildContext(actividad({ organizadorTipo: undefined })))).toBe(true);
    });

    it('respeta UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA del env', () => {
      process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA = '1000';
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 1000 })))).toBe(true);
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 999 })))).toBe(false);
    });

    it('un env invalido cae al default 500', () => {
      process.env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA = 'basura';
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 500 })))).toBe(true);
      expect(rule.appliesTo(buildContext(actividad({ capacidad: 499 })))).toBe(false);
    });
  });

  describe('apply', () => {
    it('emite ProgramarCobertura con el actividadId como eventoId y las coordenadas de ubicacion', () => {
      expect(rule.apply(buildContext(actividad()))).toEqual({
        type: 'ProgramarCobertura',
        payload: {
          eventoId: 'act-7',
          titulo: 'Festival de Primavera',
          latitud: -34.5994,
          longitud: -58.3988,
          direccion: 'Av. Cordoba 2100',
          barrio: null,
          capacidad: 1200,
          correlationId: 'act-7',
        },
      });
    });

    it('sin ubicacion deja las coordenadas en null (el handler marca validacion manual)', () => {
      const { payload } = rule.apply(buildContext(actividad({ ubicacion: undefined })));
      expect(payload.latitud).toBeNull();
      expect(payload.longitud).toBeNull();
    });

    it('ignora coordenadas que no son numericas', () => {
      const { payload } = rule.apply(buildContext(actividad({ ubicacion: { lat: '-34', lng: null } })));
      expect(payload.latitud).toBeNull();
      expect(payload.longitud).toBeNull();
    });

    it('sin titulo usa un nombre por defecto', () => {
      expect(rule.apply(buildContext(actividad({ titulo: undefined }))).payload.titulo).toBe('Actividad');
    });
  });
});
