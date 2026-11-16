jest.mock('../../../security/secure-log', () => ({ secureLog: jest.fn() }));

const path = require('path');
const { EventListener, createListeners } = require('../../../listeners');
const {
  CriticidadClimaticaConfirmadaListener,
  CriticidadClimaticaFinalizadaListener,
} = require('../../../listeners/alerta-climatica');
const {
  createCrearEmergenciaClimaticaHandler,
  createCancelarEmergenciaClimaticaHandler,
} = require('../../../listeners/alerta-climatica/handlers/emergencia-climatica.handler');
const {
  createRegistrarContextosClimaticosHandler,
  createDarDeBajaContextosClimaticosHandler,
} = require('../../../listeners/alerta-climatica/handlers/contextos-climaticos.handler');
const { buildEmergencyCreatedEvent } = require('../../../services/emergency-events');
const {
  nivelNormalizado,
  radioClimaMetros,
  ubicacionesDeLaAlerta,
  RADIO_CLIMA_DEFAULT_METROS,
} = require('../../../domain/alerta-climatica');

const kafka = { consumer: jest.fn() };
const EVENT_ID = '0b8f6c1e-6a0d-4d8e-9a39-2f1f3c7d4e55';
const ALERTA = {
  alertaId: 'a7f0e2c4-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
  nivelCriticidad: 'ALTA',
  fenomeno: 'TORMENTA_FUERTE',
  ubicaciones: [
    { latitud: -34.6037, longitud: -58.3816 },
    { latitud: -34.5631, longitud: -58.4584 },
  ],
  barrios: ['SAN NICOLAS', 'BELGRANO'],
  vigenciaDesde: 1792594800000,
  vigenciaHasta: 1792616400000,
  actorSub: 'admin-1',
};
// vigenciaHasta del payload de ejemplo de Espacios (2026-10-20): en los tests
// de la regla se corre "ahora" a antes de esa fecha.
const ANTES_DEL_FIN = 1792600000000;

function confirmada(data = {}) {
  return { metadata: { eventId: EVENT_ID }, data: { ...ALERTA, ...data } };
}

function client() {
  return { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
}

describe('listeners/alerta-climatica', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(ANTES_DEL_FIN);
  });

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('listeners', () => {
    it('se registran en createListeners', () => {
      const constructors = createListeners(kafka).map((l) => l.constructor);
      expect(constructors).toEqual(expect.arrayContaining([
        CriticidadClimaticaConfirmadaListener,
        CriticidadClimaticaFinalizadaListener,
      ]));
    });

    it('usan los tópicos de Espacios por defecto y el env los pisa', () => {
      delete process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA;
      delete process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA;
      expect(new CriticidadClimaticaConfirmadaListener(kafka).topic)
        .toBe('com.citypass.espacios.CriticidadClimaticaConfirmada');
      expect(new CriticidadClimaticaFinalizadaListener(kafka).topic)
        .toBe('com.citypass.espacios.CriticidadClimaticaFinalizada');

      process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA = 'otro.confirmada';
      expect(new CriticidadClimaticaConfirmadaListener(kafka).topic).toBe('otro.confirmada');
    });

    it('cargan las reglas de su carpeta', () => {
      const base = path.join(__dirname, '../../../listeners/alerta-climatica');
      const listener = new CriticidadClimaticaConfirmadaListener(kafka);
      expect(listener).toBeInstanceOf(EventListener);
      expect(listener.rulesDir).toBe(path.join(base, 'criticidad-climatica-confirmada', 'rules'));
    });
  });

  describe('CriticidadClimaticaConfirmada', () => {
    it('ALTA crea la emergencia y registra un contexto por punto', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada());
      expect(outcomes.map((o) => o.type)).toEqual(['CrearEmergenciaClimatica', 'RegistrarContextosClimaticos']);

      expect(outcomes[0].payload).toEqual({
        alertaId: ALERTA.alertaId,
        nivel: 'ALTA',
        fenomeno: 'TORMENTA_FUERTE',
        latitud: -34.6037,
        longitud: -58.3816,
        barrios: ['SAN NICOLAS', 'BELGRANO'],
      });

      const contextos = outcomes[1].payload;
      expect(contextos).toMatchObject({
        origen: 'espacios',
        alertaId: ALERTA.alertaId,
        radioMetros: RADIO_CLIMA_DEFAULT_METROS,
        causationId: EVENT_ID,
        descripcion: 'Alerta climática ALTA: tormenta fuerte',
      });
      expect(contextos.ubicaciones).toEqual([
        { indice: 0, latitud: -34.6037, longitud: -58.3816 },
        { indice: 1, latitud: -34.5631, longitud: -58.4584 },
      ]);
      expect(contextos.vigenteDesde).toEqual(new Date(ALERTA.vigenciaDesde));
      expect(contextos.vigenteHasta).toEqual(new Date(ALERTA.vigenciaHasta));
    });

    it('BAJA y MEDIA solo registran contextos', async () => {
      for (const nivel of ['BAJA', 'MEDIA']) {
        const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ nivelCriticidad: nivel }));
        expect(outcomes.map((o) => o.type)).toEqual(['RegistrarContextosClimaticos']);
      }
    });

    it('CRÍTICA con tilde crea la emergencia', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ nivelCriticidad: 'Crítica' }));
      expect(outcomes[0]).toMatchObject({ type: 'CrearEmergenciaClimatica', payload: { nivel: 'CRITICA' } });
    });

    it('sin ubicaciones crea la emergencia sin punto y no registra contextos', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ ubicaciones: [] }));
      expect(outcomes.map((o) => o.type)).toEqual(['CrearEmergenciaClimatica']);
      expect(outcomes[0].payload).toMatchObject({ latitud: null, longitud: null });
    });

    it('una alerta que ya venció solo deja contextos (sin emergencia)', async () => {
      Date.now.mockReturnValue(ALERTA.vigenciaHasta + 1);
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada());
      expect(outcomes.map((o) => o.type)).toEqual(['RegistrarContextosClimaticos']);
    });

    it('sin alertaId no hace nada', async () => {
      await expect(new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ alertaId: '' })))
        .resolves.toEqual([]);
    });

    it('el radio sale de CONTEXTO_ZONA_RADIO_CLIMA_METROS', async () => {
      process.env.CONTEXTO_ZONA_RADIO_CLIMA_METROS = '3500';
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada());
      expect(outcomes[1].payload.radioMetros).toBe(3500);
    });
  });

  describe('CriticidadClimaticaFinalizada', () => {
    it('cancela la emergencia y da de baja los contextos', async () => {
      const outcomes = await new CriticidadClimaticaFinalizadaListener(kafka).handle({
        metadata: { eventId: EVENT_ID },
        data: { alertaId: ALERTA.alertaId, finalizadaEn: 1792616400000, actorSub: 'admin-1' },
      });
      expect(outcomes).toEqual([
        { type: 'CancelarEmergenciaClimatica', payload: { alertaId: ALERTA.alertaId } },
        {
          type: 'DarDeBajaContextosClimaticos',
          payload: {
            origen: 'espacios',
            alertaId: ALERTA.alertaId,
            causationId: EVENT_ID,
            sourceUpdatedAt: new Date(1792616400000),
          },
        },
      ]);
    });
  });

  describe('dominio', () => {
    it('nivelNormalizado acepta mayúsculas, minúsculas y tildes', () => {
      expect(nivelNormalizado(' crítica ')).toBe('CRITICA');
      expect(nivelNormalizado('media')).toBe('MEDIA');
      expect(nivelNormalizado('ROJA')).toBeNull();
      expect(nivelNormalizado(undefined)).toBeNull();
    });

    it('un punto inválido no corre el índice de los demás', () => {
      expect(ubicacionesDeLaAlerta({
        ubicaciones: [{ latitud: 'x', longitud: 1 }, null, { latitud: -34.6, longitud: -58.4 }],
      })).toEqual([{ indice: 2, punto: { latitud: -34.6, longitud: -58.4 } }]);
    });

    it('radioClimaMetros ignora valores inválidos', () => {
      expect(radioClimaMetros({ CONTEXTO_ZONA_RADIO_CLIMA_METROS: '-1' })).toBe(RADIO_CLIMA_DEFAULT_METROS);
      expect(radioClimaMetros({})).toBe(RADIO_CLIMA_DEFAULT_METROS);
    });
  });

  describe('CrearEmergenciaClimatica', () => {
    const payload = {
      alertaId: ALERTA.alertaId,
      nivel: 'CRITICA',
      fenomeno: 'TORMENTA_FUERTE',
      latitud: -34.6037,
      longitud: -58.3816,
      barrios: ['SAN NICOLAS'],
    };

    it('crea una PREVENTIVA externa con la causa climática', async () => {
      const emergencyRepository = { findByCausa: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) };
      const c = client();
      const result = await createCrearEmergenciaClimaticaHandler({ emergencyRepository, topic: 't' })(c, payload);

      expect(result.created).toBe(true);
      expect(emergencyRepository.findByCausa).toHaveBeenCalledWith(c, {
        causaTipo: 'EVENTO_CLIMATICO',
        causaId: ALERTA.alertaId,
        emergencyType: 'PREVENTIVA',
      });
      expect(emergencyRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        client: c,
        latitude: -34.6037,
        longitude: -58.3816,
        barrioText: 'SAN NICOLAS',
        severity: 'critical',
        emergencyType: 'PREVENTIVA',
        status: 'PENDING',
        source: 'EXTERNAL',
        requiresManualValidation: false,
        causaTipo: 'EVENTO_CLIMATICO',
        causaId: ALERTA.alertaId,
        description: 'Alerta climática CRITICA — tormenta fuerte (SAN NICOLAS)',
      }));
    });

    it('no duplica si la alerta ya tiene emergencia', async () => {
      const emergencyRepository = { findByCausa: jest.fn().mockResolvedValue([{ id: 'e-1' }]), create: jest.fn() };
      const result = await createCrearEmergenciaClimaticaHandler({ emergencyRepository })(client(), payload);
      expect(result).toEqual({ emergencyId: 'e-1', created: false });
      expect(emergencyRepository.create).not.toHaveBeenCalled();
    });

    it('si otro evento la creó en paralelo, devuelve la ganadora', async () => {
      const duplicate = Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_emergencies_preventiva_causa' });
      const emergencyRepository = {
        findByCausa: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'e-2' }]),
        create: jest.fn().mockRejectedValue(duplicate),
      };
      const c = client();
      const result = await createCrearEmergenciaClimaticaHandler({ emergencyRepository })(c, payload);
      expect(result).toEqual({ emergencyId: 'e-2', created: false });
      expect(c.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT crear_emergencia_climatica');
    });

    it('sin punto queda para validación manual', async () => {
      const emergencyRepository = { findByCausa: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) };
      await createCrearEmergenciaClimaticaHandler({ emergencyRepository })(client(), { ...payload, latitud: null, longitud: null });
      expect(emergencyRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        latitude: null,
        longitude: null,
        requiresManualValidation: true,
      }));
    });

    it('rechaza un nivel desconocido', async () => {
      const emergencyRepository = { findByCausa: jest.fn(), create: jest.fn() };
      await expect(createCrearEmergenciaClimaticaHandler({ emergencyRepository })(client(), { ...payload, nivel: 'ROJA' }))
        .rejects.toThrow('nivel');
    });
  });

  describe('CancelarEmergenciaClimatica', () => {
    it('cancela solo las que no avanzaron', async () => {
      const emergencyRepository = {
        findByCausa: jest.fn().mockResolvedValue([
          { id: 'e-1', status: 'PENDING' },
          { id: 'e-2', status: 'DISPATCHED' },
        ]),
        updateStatus: jest.fn().mockResolvedValue({}),
      };
      const result = await createCancelarEmergenciaClimaticaHandler({ emergencyRepository })(client(), { alertaId: ALERTA.alertaId });
      expect(result).toEqual({ cancelled: 1 });
      expect(emergencyRepository.updateStatus).toHaveBeenCalledTimes(1);
      expect(emergencyRepository.updateStatus).toHaveBeenCalledWith('e-1', expect.objectContaining({
        newStatus: 'CANCELLED',
        actor: 'eda:espacios',
        reason: 'Alerta climática finalizada',
      }));
    });
  });

  describe('contextos climáticos', () => {
    const base = {
      origen: 'espacios',
      alertaId: ALERTA.alertaId,
      ubicaciones: [
        { indice: 0, latitud: -34.6037, longitud: -58.3816 },
        { indice: 1, latitud: -34.5631, longitud: -58.4584 },
      ],
      radioMetros: 2000,
      vigenteDesde: new Date(ALERTA.vigenciaDesde),
      vigenteHasta: new Date(ALERTA.vigenciaHasta),
      descripcion: 'Alerta climática ALTA: tormenta fuerte',
      causationId: EVENT_ID,
      sourceUpdatedAt: new Date(ALERTA.vigenciaDesde),
    };

    function repo({ dadoDeBaja = false } = {}) {
      return {
        bloquearGrupo: jest.fn().mockResolvedValue(),
        grupoDadoDeBaja: jest.fn().mockResolvedValue(dadoDeBaja),
        upsert: jest.fn().mockResolvedValue({ id: 'ctx' }),
        darDeBajaGrupo: jest.fn().mockResolvedValue(2),
      };
    }

    it('registra un contexto por punto con referencia <alertaId>#<índice>', async () => {
      const contextoZonaRepository = repo();
      const c = client();
      const result = await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })(c, base);

      expect(result).toEqual({ applied: 2, finalizada: false });
      expect(contextoZonaRepository.bloquearGrupo).toHaveBeenCalledWith(c, {
        tipo: 'ALERTA_CLIMATICA', origen: 'espacios', referenciaBase: ALERTA.alertaId,
      });
      expect(contextoZonaRepository.upsert.mock.calls.map(([, p]) => p.referenciaExterna)).toEqual([
        `${ALERTA.alertaId}#0`,
        `${ALERTA.alertaId}#1`,
      ]);
      expect(contextoZonaRepository.upsert).toHaveBeenCalledWith(c, expect.objectContaining({
        tipo: 'ALERTA_CLIMATICA',
        latitud: -34.6037,
        longitud: -58.3816,
        radioMetros: 2000,
      }));
    });

    it('no registra nada si la alerta ya se finalizó', async () => {
      const contextoZonaRepository = repo({ dadoDeBaja: true });
      const result = await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })(client(), base);
      expect(result).toEqual({ applied: 0, finalizada: true });
      expect(contextoZonaRepository.upsert).not.toHaveBeenCalled();
    });

    it('da de baja el grupo de la alerta', async () => {
      const contextoZonaRepository = repo();
      const c = client();
      const result = await createDarDeBajaContextosClimaticosHandler({ contextoZonaRepository })(c, {
        origen: 'espacios', alertaId: ALERTA.alertaId, causationId: EVENT_ID, sourceUpdatedAt: new Date(0),
      });
      expect(result).toEqual({ dadosDeBaja: 2 });
      expect(contextoZonaRepository.bloquearGrupo).toHaveBeenCalled();
      expect(contextoZonaRepository.darDeBajaGrupo).toHaveBeenCalledWith(c, expect.objectContaining({
        tipo: 'ALERTA_CLIMATICA', origen: 'espacios', referenciaBase: ALERTA.alertaId,
      }));
    });

    it('rechaza un alta sin ubicaciones', async () => {
      await expect(createRegistrarContextosClimaticosHandler({ contextoZonaRepository: repo() })(client(), { ...base, ubicaciones: [] }))
        .rejects.toThrow('ubicación');
    });
  });

  describe('EmergenciaCreada', () => {
    const emergencia = {
      id: '5d1e9a7c-3b2f-4f61-9c8e-0a4b7d2e6f13',
      emergencyType: 'PREVENTIVA',
      severity: 'high',
      status: 'PENDING',
      createdAt: '2026-11-16T12:00:00.000Z',
    };

    it('una emergencia climática lleva prioridadOriginal igual a prioridad', () => {
      const { data } = buildEmergencyCreatedEvent(
        { ...emergencia, causaTipo: 'EVENTO_CLIMATICO', causaId: ALERTA.alertaId },
        'evt',
        { busCrypto: null }
      );
      expect(data.prioridad).toBe('ALTA');
      expect(data.prioridadOriginal).toBe('ALTA');
    });

    it('otras causas siguen con prioridadOriginal null', () => {
      const { data } = buildEmergencyCreatedEvent(
        { ...emergencia, causaTipo: 'EVENTO_PUBLICO', causaId: 'ev-1' },
        'evt',
        { busCrypto: null }
      );
      expect(data.prioridadOriginal).toBeNull();
    });
  });
});
