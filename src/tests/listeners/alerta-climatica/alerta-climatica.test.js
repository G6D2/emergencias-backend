jest.mock('../../../security/secure-log', () => ({ secureLog: jest.fn() }));

const path = require('path');
const { EventListener, createListeners } = require('../../../listeners');
const { EventConsumer } = require('../../../listeners/event-consumer');
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
const { zonaDelBarrio } = require('../../../domain/barrio');
const { ContextoZonaRepository } = require('../../../repositories/contexto-zona.repository');
const { CrearEmergenciaClimaticaRule } = require('../../../listeners/alerta-climatica/criticidad-climatica-confirmada/rules/01-crear-emergencia-climatica.rule');
const { RegistrarContextosClimaticosRule } = require('../../../listeners/alerta-climatica/criticidad-climatica-confirmada/rules/02-registrar-contextos-climaticos.rule');
const { CancelarEmergenciaClimaticaRule } = require('../../../listeners/alerta-climatica/criticidad-climatica-finalizada/rules/01-cancelar-emergencia-climatica.rule');
const { DarDeBajaContextosClimaticosRule } = require('../../../listeners/alerta-climatica/criticidad-climatica-finalizada/rules/02-dar-de-baja-contextos-climaticos.rule');
const {
  barriosDeLaAlerta,
  esNivelAccionable,
  fenomenoLegible,
  grupoDeLaAlerta,
  nivelNormalizado,
  radioClimaMetros,
  severityDelNivel,
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
const GRUPO = { tipo: 'ALERTA_CLIMATICA', origen: 'espacios', referenciaBase: ALERTA.alertaId };
const RADIO_ENV = ['CONTEXTO_ZONA_RADIO_CLIMA_ALTA_METROS', 'CONTEXTO_ZONA_RADIO_CLIMA_CRITICA_METROS'];

function confirmada(data = {}) {
  return { metadata: { eventId: EVENT_ID }, data: { ...ALERTA, ...data } };
}

function client() {
  return { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
}

function contextoRepo({ dadoDeBaja = false } = {}) {
  return {
    bloquearGrupo: jest.fn().mockResolvedValue(),
    grupoDadoDeBaja: jest.fn().mockResolvedValue(dadoDeBaja),
    upsert: jest.fn().mockResolvedValue({ id: 'ctx' }),
    darDeBajaGrupo: jest.fn().mockResolvedValue(2),
  };
}

describe('listeners/alerta-climatica', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(ANTES_DEL_FIN);
    RADIO_ENV.forEach((name) => delete process.env[name]);
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

    it('son opt-in: sin variable no tienen topic y con la variable la usan', () => {
      delete process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA;
      delete process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA;
      expect(new CriticidadClimaticaConfirmadaListener(kafka).topic).toBeUndefined();
      expect(new CriticidadClimaticaFinalizadaListener(kafka).topic).toBeUndefined();

      process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA = 'com.citypass.espacios.CriticidadClimaticaConfirmada';
      process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA = 'com.citypass.espacios.CriticidadClimaticaFinalizada';
      expect(new CriticidadClimaticaConfirmadaListener(kafka).topic)
        .toBe('com.citypass.espacios.CriticidadClimaticaConfirmada');
      expect(new CriticidadClimaticaFinalizadaListener(kafka).topic)
        .toBe('com.citypass.espacios.CriticidadClimaticaFinalizada');
    });

    it('sin variable el consumer no se suscribe y /health los muestra disabled', () => {
      delete process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA;
      delete process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA;
      const consumer = new EventConsumer(kafka, createListeners(kafka));
      expect(consumer.topics().some((topic) => topic.includes('CriticidadClimatica'))).toBe(false);

      const statuses = consumer.listenerStatuses({ running: true, lastPollAt: null, status: 'running', nextRetryAt: null });
      const clima = statuses.filter((s) => s.name.startsWith('CriticidadClimatica'));
      expect(clima).toEqual([
        { name: 'CriticidadClimaticaConfirmadaListener', running: false, lastPollAt: null, status: 'disabled', nextRetryAt: null },
        { name: 'CriticidadClimaticaFinalizadaListener', running: false, lastPollAt: null, status: 'disabled', nextRetryAt: null },
      ]);
    });

    it('con las variables el consumer se suscribe a los dos tópicos', () => {
      process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_CONFIRMADA = 'clima.confirmada';
      process.env.EDA_TOPIC_CRITICIDAD_CLIMATICA_FINALIZADA = 'clima.finalizada';
      const consumer = new EventConsumer(kafka, createListeners(kafka));
      expect(consumer.topics()).toEqual(expect.arrayContaining(['clima.confirmada', 'clima.finalizada']));
    });

    it('cargan las reglas de su carpeta', () => {
      const base = path.join(__dirname, '../../../listeners/alerta-climatica');
      const listener = new CriticidadClimaticaConfirmadaListener(kafka);
      expect(listener).toBeInstanceOf(EventListener);
      expect(listener.rulesDir).toBe(path.join(base, 'criticidad-climatica-confirmada', 'rules'));
      expect(new CriticidadClimaticaFinalizadaListener(kafka).rulesDir)
        .toBe(path.join(base, 'criticidad-climatica-finalizada', 'rules'));
    });
  });

  describe('CriticidadClimaticaConfirmada', () => {
    it('ALTA crea la emergencia y registra un contexto por barrio, con el círculo de cada barrio', async () => {
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
        radioMetros: 500,
        causationId: EVENT_ID,
        descripcion: 'Alerta climática ALTA: tormenta fuerte',
      });
      expect(contextos.ubicaciones).toEqual([
        { indice: 0, barrio: 'SAN NICOLAS', ...zonaDelBarrio('SAN NICOLAS') },
        { indice: 1, barrio: 'BELGRANO', ...zonaDelBarrio('BELGRANO') },
      ]);
      expect(contextos.vigenteDesde).toEqual(new Date(ALERTA.vigenciaDesde));
      expect(contextos.vigenteHasta).toEqual(new Date(ALERTA.vigenciaHasta));
    });

    it('sin barrios del catálogo registra un contexto por punto con el radio del nivel', async () => {
      for (const barrios of [[], ['NARNIA'], undefined]) {
        const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ barrios }));
        expect(outcomes[1].payload.ubicaciones).toEqual([
          { indice: 0, latitud: -34.6037, longitud: -58.3816, radioMetros: 500, barrio: null },
          { indice: 1, latitud: -34.5631, longitud: -58.4584, radioMetros: 500, barrio: null },
        ]);
      }
    });

    it('un barrio fuera del catálogo se descarta sin correr el índice de los demás', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({
        barrios: ['NARNIA', 'belgrano', 'BELGRANO'],
      }));
      expect(outcomes[1].payload.ubicaciones.map((u) => [u.indice, u.barrio])).toEqual([[1, 'BELGRANO']]);
    });

    it('CRITICA registra los contextos con radio de 1000 m', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ nivelCriticidad: 'CRITICA' }));
      expect(outcomes.map((o) => o.type)).toEqual(['CrearEmergenciaClimatica', 'RegistrarContextosClimaticos']);
      expect(outcomes[1].payload).toMatchObject({
        radioMetros: 1000,
        descripcion: 'Alerta climática CRITICA: tormenta fuerte',
      });
    });

    it('BAJA y MEDIA no generan nada', async () => {
      for (const nivel of ['BAJA', 'MEDIA', 'media']) {
        const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ nivelCriticidad: nivel }));
        expect(outcomes).toEqual([]);
      }
    });

    it('un nivel fuera del catálogo no genera nada', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ nivelCriticidad: 'ROJA' }));
      expect(outcomes).toEqual([]);
    });

    it('CRÍTICA con tilde crea la emergencia', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ nivelCriticidad: 'Crítica' }));
      expect(outcomes[0]).toMatchObject({ type: 'CrearEmergenciaClimatica', payload: { nivel: 'CRITICA' } });
      expect(outcomes[1].payload.radioMetros).toBe(1000);
    });

    it('sin ubicaciones pero con barrios, crea la emergencia sin punto y registra los contextos por barrio', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ ubicaciones: [] }));
      expect(outcomes.map((o) => o.type)).toEqual(['CrearEmergenciaClimatica', 'RegistrarContextosClimaticos']);
      expect(outcomes[0].payload).toMatchObject({ latitud: null, longitud: null });
      expect(outcomes[1].payload.ubicaciones.map((u) => u.barrio)).toEqual(['SAN NICOLAS', 'BELGRANO']);
    });

    it('sin ubicaciones ni barrios del catálogo crea la emergencia sin punto y no registra contextos', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ ubicaciones: [], barrios: [] }));
      expect(outcomes.map((o) => o.type)).toEqual(['CrearEmergenciaClimatica']);
      expect(outcomes[0].payload).toMatchObject({ latitud: null, longitud: null });
    });

    it('la emergencia va en el primer punto válido', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({
        ubicaciones: [{ latitud: 'x', longitud: 1 }, { latitud: -34.5631, longitud: -58.4584 }],
        barrios: [],
      }));
      expect(outcomes[0].payload).toMatchObject({ latitud: -34.5631, longitud: -58.4584 });
      expect(outcomes[1].payload.ubicaciones).toEqual([
        { indice: 1, latitud: -34.5631, longitud: -58.4584, radioMetros: 500, barrio: null },
      ]);
    });

    it('una alerta que ya venció solo deja contextos (sin emergencia)', async () => {
      Date.now.mockReturnValue(ALERTA.vigenciaHasta + 1);
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada());
      expect(outcomes.map((o) => o.type)).toEqual(['RegistrarContextosClimaticos']);
    });

    it('sin vigenciaHasta se asume vigente', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ vigenciaHasta: undefined }));
      expect(outcomes[0].type).toBe('CrearEmergenciaClimatica');
    });

    it('sin alertaId no hace nada', async () => {
      await expect(new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ alertaId: '' })))
        .resolves.toEqual([]);
    });

    it('sin fenomeno la descripción dice "evento climático"', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ fenomeno: undefined }));
      expect(outcomes[0].payload.fenomeno).toBeNull();
      expect(outcomes[1].payload.descripcion).toBe('Alerta climática ALTA: evento climático');
    });

    it('el sourceUpdatedAt sale del envelope', async () => {
      const outcomes = await new CriticidadClimaticaConfirmadaListener(kafka).handle({
        metadata: { eventId: 'no-uuid', occurredAt: '2026-10-20T10:00:00.000Z' },
        data: ALERTA,
      });
      expect(outcomes[1].payload.sourceUpdatedAt).toEqual(new Date('2026-10-20T10:00:00.000Z'));
      expect(outcomes[1].payload.causationId).toBeNull();
    });

    it('cada radio sale de su variable de entorno', async () => {
      process.env.CONTEXTO_ZONA_RADIO_CLIMA_ALTA_METROS = '750';
      process.env.CONTEXTO_ZONA_RADIO_CLIMA_CRITICA_METROS = '1500';
      const alta = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada());
      const critica = await new CriticidadClimaticaConfirmadaListener(kafka).handle(confirmada({ nivelCriticidad: 'CRITICA' }));
      expect(alta[1].payload.radioMetros).toBe(750);
      expect(critica[1].payload.radioMetros).toBe(1500);
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

    it('sin finalizadaEn ni eventId UUID usa ahora y causationId null', async () => {
      const [, baja] = await new CriticidadClimaticaFinalizadaListener(kafka).handle({
        metadata: { eventId: 'no-uuid' },
        data: { alertaId: ALERTA.alertaId },
      });
      expect(baja.payload.causationId).toBeNull();
      expect(baja.payload.sourceUpdatedAt).toBeInstanceOf(Date);
    });

    it('sin alertaId no hace nada', async () => {
      await expect(new CriticidadClimaticaFinalizadaListener(kafka).handle({
        metadata: { eventId: EVENT_ID },
        data: { finalizadaEn: 1792616400000 },
      })).resolves.toEqual([]);
    });
  });

  describe('dominio', () => {
    it('nivelNormalizado acepta mayúsculas, minúsculas y tildes', () => {
      expect(nivelNormalizado(' crítica ')).toBe('CRITICA');
      expect(nivelNormalizado('media')).toBe('MEDIA');
      expect(nivelNormalizado('ROJA')).toBeNull();
      expect(nivelNormalizado(undefined)).toBeNull();
    });

    it('solo ALTA y CRITICA son accionables, con su severidad', () => {
      expect(['BAJA', 'MEDIA', 'ALTA', 'CRITICA', null].map(esNivelAccionable))
        .toEqual([false, false, true, true, false]);
      expect(severityDelNivel('ALTA')).toBe('high');
      expect(severityDelNivel('CRITICA')).toBe('critical');
      expect(severityDelNivel('MEDIA')).toBeNull();
    });

    it('un punto inválido no corre el índice de los demás', () => {
      expect(ubicacionesDeLaAlerta({
        ubicaciones: [{ latitud: 'x', longitud: 1 }, null, { latitud: -34.6, longitud: -58.4 }],
      })).toEqual([{ indice: 2, punto: { latitud: -34.6, longitud: -58.4 } }]);
      expect(ubicacionesDeLaAlerta({})).toEqual([]);
    });

    it('radioClimaMetros: default por nivel, valores inválidos ignorados y null sin nivel accionable', () => {
      expect(RADIO_CLIMA_DEFAULT_METROS).toEqual({ ALTA: 500, CRITICA: 1000 });
      expect(radioClimaMetros('ALTA', {})).toBe(500);
      expect(radioClimaMetros('CRITICA', {})).toBe(1000);
      expect(radioClimaMetros('ALTA', { CONTEXTO_ZONA_RADIO_CLIMA_ALTA_METROS: '-1' })).toBe(500);
      expect(radioClimaMetros('CRITICA', { CONTEXTO_ZONA_RADIO_CLIMA_CRITICA_METROS: 'mil' })).toBe(1000);
      expect(radioClimaMetros('CRITICA', { CONTEXTO_ZONA_RADIO_CLIMA_CRITICA_METROS: '1200.6' })).toBe(1201);
      expect(radioClimaMetros('MEDIA', { CONTEXTO_ZONA_RADIO_CLIMA_ALTA_METROS: '800' })).toBeNull();
      expect(radioClimaMetros('BAJA')).toBeNull();
    });

    it('fenomenoLegible y grupoDeLaAlerta', () => {
      expect(fenomenoLegible(' LLUVIA_INTENSA ')).toBe('lluvia intensa');
      expect(fenomenoLegible('')).toBe('evento climático');
      expect(grupoDeLaAlerta(ALERTA.alertaId)).toEqual(GRUPO);
      expect(grupoDeLaAlerta('a-1', 'otro')).toEqual({ tipo: 'ALERTA_CLIMATICA', origen: 'otro', referenciaBase: 'a-1' });
    });
  });

  describe('reglas con un contexto vacío', () => {
    it('ninguna aplica sin data', () => {
      for (const Rule of [
        CrearEmergenciaClimaticaRule, RegistrarContextosClimaticosRule,
        CancelarEmergenciaClimaticaRule, DarDeBajaContextosClimaticosRule,
      ]) {
        expect(new Rule().appliesTo({})).toBe(false);
      }
    });

    it('apply tolera un contexto sin data ni metadata', () => {
      expect(new CrearEmergenciaClimaticaRule().apply({}).payload).toEqual({
        alertaId: undefined, nivel: null, fenomeno: null, latitud: null, longitud: null, barrios: [],
      });
      expect(new CancelarEmergenciaClimaticaRule().apply({}).payload).toEqual({ alertaId: undefined });
      expect(new DarDeBajaContextosClimaticosRule().apply({}).payload).toMatchObject({
        origen: 'espacios', causationId: null, sourceUpdatedAt: expect.any(Date),
      });
      const registrar = new RegistrarContextosClimaticosRule().apply({ data: { ...ALERTA } });
      expect(registrar.payload).toMatchObject({ causationId: null, radioMetros: 500, sourceUpdatedAt: expect.any(Date) });
      expect(new RegistrarContextosClimaticosRule().apply({}).payload).toMatchObject({ ubicaciones: [], radioMetros: null });
    });

    it('barrios y ubicaciones toleran un payload vacío', () => {
      expect(barriosDeLaAlerta()).toEqual([]);
      expect(barriosDeLaAlerta({ barrios: 'PALERMO' })).toEqual([]);
      expect(barriosDeLaAlerta({ barrios: [' PALERMO ', '', 3] })).toEqual(['PALERMO']);
      expect(ubicacionesDeLaAlerta()).toEqual([]);
      expect(radioClimaMetros('ALTA')).toBe(500);
    });
  });

  describe('ContextoZonaRepository: grupo de una alerta', () => {
    it('bloquearGrupo toma un advisory lock de la transacción por grupo', async () => {
      const c = client();
      await new ContextoZonaRepository({ query: jest.fn() }).bloquearGrupo(c, GRUPO);
      expect(c.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`contexto_zona:ALERTA_CLIMATICA:espacios:${ALERTA.alertaId}`]
      );
    });

    it('grupoDadoDeBaja busca la marca de la alerta (con el pool si no hay client)', async () => {
      const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{}] }) };
      const repository = new ContextoZonaRepository(pool);
      await expect(repository.grupoDadoDeBaja(null, GRUPO)).resolves.toBe(true);
      const [sql, values] = pool.query.mock.calls[0];
      expect(sql).toContain('dado_de_baja_en IS NOT NULL');
      expect(values).toEqual(['ALERTA_CLIMATICA', 'espacios', ALERTA.alertaId]);

      const c = client();
      await expect(repository.grupoDadoDeBaja(c, GRUPO)).resolves.toBe(false);
      expect(c.query).toHaveBeenCalled();
    });

    it('darDeBajaGrupo deja la marca y da de baja los puntos <alertaId>#n', async () => {
      const c = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 2, rows: [] }) };
      const repository = new ContextoZonaRepository({ query: jest.fn() });
      const sourceUpdatedAt = new Date(ALERTA.vigenciaHasta);
      await expect(repository.darDeBajaGrupo(c, { ...GRUPO, sourceUpdatedAt })).resolves.toBe(2);

      const [marcaSql, marcaValues] = c.query.mock.calls[0];
      expect(marcaSql).toContain('INSERT INTO contexto_zona');
      expect(marcaValues).toEqual(['ALERTA_CLIMATICA', 'espacios', ALERTA.alertaId, null, sourceUpdatedAt]);
      const [puntosSql, puntosValues] = c.query.mock.calls[1];
      expect(puntosSql).toContain("left(referencia_externa, length($3) + 1) = $3 || '#'");
      expect(puntosValues).toEqual(['ALERTA_CLIMATICA', 'espacios', ALERTA.alertaId, sourceUpdatedAt]);
    });

    it('darDeBajaGrupo usa el pool si no hay client', async () => {
      const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
      await expect(new ContextoZonaRepository(pool).darDeBajaGrupo(null, { ...GRUPO, sourceUpdatedAt: new Date(0) }))
        .resolves.toBe(0);
      expect(pool.query).toHaveBeenCalledTimes(2);
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

    function emergencyRepo(existing = []) {
      return { findByCausa: jest.fn().mockResolvedValue(existing), create: jest.fn().mockResolvedValue({}) };
    }

    it('exige los dos repositorios', () => {
      expect(() => createCrearEmergenciaClimaticaHandler({ contextoZonaRepository: contextoRepo() }))
        .toThrow('emergencyRepository');
      expect(() => createCrearEmergenciaClimaticaHandler({ emergencyRepository: emergencyRepo() }))
        .toThrow('contextoZonaRepository');
    });

    it('crea una PREVENTIVA externa con la causa climática', async () => {
      const emergencyRepository = emergencyRepo();
      const contextoZonaRepository = contextoRepo();
      const c = client();
      const result = await createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository, topic: 't' })(c, payload);

      expect(result.created).toBe(true);
      expect(contextoZonaRepository.bloquearGrupo).toHaveBeenCalledWith(c, GRUPO);
      expect(contextoZonaRepository.grupoDadoDeBaja).toHaveBeenCalledWith(c, GRUPO);
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
        userId: null,
        requiresManualValidation: false,
        causaTipo: 'EVENTO_CLIMATICO',
        causaId: ALERTA.alertaId,
        description: 'Alerta climática CRITICA — tormenta fuerte (SAN NICOLAS)',
      }));
      expect(c.query).toHaveBeenCalledWith('RELEASE SAVEPOINT crear_emergencia_climatica');

      // El outbox arma EmergenciaCreada con la emergencia guardada.
      const { outboxEvent } = emergencyRepository.create.mock.calls[0][0];
      expect(outboxEvent.topic).toBe('t');
      const evento = outboxEvent.payload({
        id: '5d1e9a7c-3b2f-4f61-9c8e-0a4b7d2e6f13',
        emergencyType: 'PREVENTIVA',
        severity: 'critical',
        status: 'PENDING',
        causaTipo: 'EVENTO_CLIMATICO',
        causaId: ALERTA.alertaId,
        createdAt: '2026-11-16T12:00:00.000Z',
      }, 'evt-1');
      expect(evento.data).toMatchObject({ prioridad: 'CRITICA', prioridadOriginal: 'CRITICA', causaTipo: 'EVENTO_CLIMATICO' });
    });

    it('ALTA crea la PREVENTIVA con severidad high', async () => {
      const emergencyRepository = emergencyRepo();
      await createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository: contextoRepo() })(
        client(), { ...payload, nivel: 'ALTA', barrios: [] }
      );
      expect(emergencyRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        severity: 'high',
        barrioText: null,
        description: 'Alerta climática ALTA — tormenta fuerte',
      }));
    });

    it('si la alerta ya se finalizó no crea nada', async () => {
      const emergencyRepository = emergencyRepo();
      const contextoZonaRepository = contextoRepo({ dadoDeBaja: true });
      const result = await createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository })(client(), payload);
      expect(result).toEqual({ emergencyId: null, created: false, finalizada: true });
      expect(contextoZonaRepository.bloquearGrupo).toHaveBeenCalled();
      expect(emergencyRepository.findByCausa).not.toHaveBeenCalled();
      expect(emergencyRepository.create).not.toHaveBeenCalled();
    });

    it('no duplica si la alerta ya tiene emergencia', async () => {
      const emergencyRepository = emergencyRepo([{ id: 'e-1' }]);
      const result = await createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository: contextoRepo() })(client(), payload);
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
      const result = await createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository: contextoRepo() })(c, payload);
      expect(result).toEqual({ emergencyId: 'e-2', created: false });
      expect(c.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT crear_emergencia_climatica');
    });

    it('un duplicado sin ganadora visible se reintenta (transitorio)', async () => {
      const duplicate = Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_emergencies_preventiva_causa' });
      const emergencyRepository = {
        findByCausa: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockRejectedValue(duplicate),
      };
      await expect(createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository: contextoRepo() })(client(), payload))
        .rejects.toMatchObject({ transient: true });
    });

    it('otros errores del alta se propagan', async () => {
      const emergencyRepository = {
        findByCausa: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: '23514' })),
      };
      await expect(createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository: contextoRepo() })(client(), payload))
        .rejects.toThrow('boom');
    });

    it('sin punto queda para validación manual', async () => {
      const emergencyRepository = emergencyRepo();
      await createCrearEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository: contextoRepo() })(
        client(), { ...payload, latitud: null, longitud: null }
      );
      expect(emergencyRepository.create).toHaveBeenCalledWith(expect.objectContaining({
        latitude: null,
        longitude: null,
        requiresManualValidation: true,
      }));
    });

    it('rechaza MEDIA, BAJA o un nivel desconocido', async () => {
      const handler = createCrearEmergenciaClimaticaHandler({ emergencyRepository: emergencyRepo(), contextoZonaRepository: contextoRepo() });
      for (const nivel of ['MEDIA', 'BAJA', 'ROJA']) {
        await expect(handler(client(), { ...payload, nivel })).rejects.toThrow('ALTA o CRITICA');
      }
    });

    it('rechaza un payload sin alertaId', async () => {
      const handler = createCrearEmergenciaClimaticaHandler({ emergencyRepository: emergencyRepo(), contextoZonaRepository: contextoRepo() });
      await expect(handler(client(), undefined)).rejects.toThrow('alertaId');
    });
  });

  describe('CancelarEmergenciaClimatica', () => {
    it('exige los dos repositorios', () => {
      expect(() => createCancelarEmergenciaClimaticaHandler({ contextoZonaRepository: contextoRepo() }))
        .toThrow('emergencyRepository');
      expect(() => createCancelarEmergenciaClimaticaHandler({ emergencyRepository: {} }))
        .toThrow('contextoZonaRepository');
    });

    it('toma el lock de la alerta y cancela solo las que no avanzaron', async () => {
      const emergencyRepository = {
        findByCausa: jest.fn().mockResolvedValue([
          { id: 'e-1', status: 'PENDING' },
          { id: 'e-2', status: 'DISPATCHED' },
        ]),
        updateStatus: jest.fn().mockResolvedValue({}),
      };
      const contextoZonaRepository = contextoRepo();
      const c = client();
      const result = await createCancelarEmergenciaClimaticaHandler({ emergencyRepository, contextoZonaRepository, topic: 'u' })(
        c, { alertaId: ALERTA.alertaId }
      );
      expect(result).toEqual({ cancelled: 1 });
      expect(contextoZonaRepository.bloquearGrupo).toHaveBeenCalledWith(c, GRUPO);
      expect(contextoZonaRepository.bloquearGrupo.mock.invocationCallOrder[0])
        .toBeLessThan(emergencyRepository.findByCausa.mock.invocationCallOrder[0]);
      expect(emergencyRepository.updateStatus).toHaveBeenCalledTimes(1);
      expect(emergencyRepository.updateStatus).toHaveBeenCalledWith('e-1', expect.objectContaining({
        client: c,
        newStatus: 'CANCELLED',
        actor: 'eda:espacios',
        reason: 'Alerta climática finalizada',
      }));

      const { outboxEvent } = emergencyRepository.updateStatus.mock.calls[0][1];
      expect(outboxEvent.topic).toBe('u');
      const evento = outboxEvent.payload({
        emergency: { id: 'e-1', status: 'CANCELLED', severity: 'high', emergencyType: 'PREVENTIVA' },
        history: { previousStatus: 'PENDING', newStatus: 'CANCELLED', createdAt: '2026-11-16T12:00:00.000Z' },
      }, 'evt-2');
      expect(evento.data).toMatchObject({ emergenciaId: 'e-1', estadoNuevo: 'CANCELADA' });
    });

    it('rechaza un payload sin alertaId', async () => {
      const handler = createCancelarEmergenciaClimaticaHandler({ emergencyRepository: {}, contextoZonaRepository: contextoRepo() });
      await expect(handler(client(), {})).rejects.toThrow('alertaId');
      await expect(handler(client(), undefined)).rejects.toThrow('alertaId');
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
      radioMetros: 500,
      vigenteDesde: new Date(ALERTA.vigenciaDesde),
      vigenteHasta: new Date(ALERTA.vigenciaHasta),
      descripcion: 'Alerta climática ALTA: tormenta fuerte',
      causationId: EVENT_ID,
      sourceUpdatedAt: new Date(ALERTA.vigenciaDesde),
    };

    it('exigen el repositorio', () => {
      expect(() => createRegistrarContextosClimaticosHandler({})).toThrow('contextoZonaRepository');
      expect(() => createDarDeBajaContextosClimaticosHandler({})).toThrow('contextoZonaRepository');
    });

    it('registra un contexto por punto con referencia <alertaId>#<índice>', async () => {
      const contextoZonaRepository = contextoRepo();
      const c = client();
      const result = await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })(c, base);

      expect(result).toEqual({ applied: 2, finalizada: false });
      expect(contextoZonaRepository.bloquearGrupo).toHaveBeenCalledWith(c, GRUPO);
      expect(contextoZonaRepository.upsert.mock.calls.map(([, p]) => p.referenciaExterna)).toEqual([
        `${ALERTA.alertaId}#0`,
        `${ALERTA.alertaId}#1`,
      ]);
      expect(contextoZonaRepository.upsert).toHaveBeenCalledWith(c, expect.objectContaining({
        tipo: 'ALERTA_CLIMATICA',
        latitud: -34.6037,
        longitud: -58.3816,
        radioMetros: 500,
      }));
    });

    it('sin descripción ni causationId los guarda en null', async () => {
      const contextoZonaRepository = contextoRepo();
      const sinOpcionales = { ...base };
      delete sinOpcionales.descripcion;
      delete sinOpcionales.causationId;
      await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })(client(), sinOpcionales);
      expect(contextoZonaRepository.upsert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        descripcion: null,
        causationId: null,
      }));

      await createDarDeBajaContextosClimaticosHandler({ contextoZonaRepository })(client(), {
        origen: 'espacios', alertaId: ALERTA.alertaId, sourceUpdatedAt: new Date(0),
      });
      expect(contextoZonaRepository.darDeBajaGrupo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        causationId: null,
      }));
    });

    it('no cuenta un alta que no aplicó (más vieja o dada de baja)', async () => {
      const contextoZonaRepository = contextoRepo();
      contextoZonaRepository.upsert.mockResolvedValueOnce(null);
      const result = await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })(client(), base);
      expect(result).toEqual({ applied: 1, finalizada: false });
    });

    it('no registra nada si la alerta ya se finalizó', async () => {
      const contextoZonaRepository = contextoRepo({ dadoDeBaja: true });
      const result = await createRegistrarContextosClimaticosHandler({ contextoZonaRepository })(client(), base);
      expect(result).toEqual({ applied: 0, finalizada: true });
      expect(contextoZonaRepository.upsert).not.toHaveBeenCalled();
    });

    it('da de baja el grupo de la alerta', async () => {
      const contextoZonaRepository = contextoRepo();
      const c = client();
      const result = await createDarDeBajaContextosClimaticosHandler({ contextoZonaRepository })(c, {
        origen: 'espacios', alertaId: ALERTA.alertaId, causationId: EVENT_ID, sourceUpdatedAt: new Date(0),
      });
      expect(result).toEqual({ dadosDeBaja: 2 });
      expect(contextoZonaRepository.bloquearGrupo).toHaveBeenCalledWith(c, GRUPO);
      expect(contextoZonaRepository.darDeBajaGrupo).toHaveBeenCalledWith(c, expect.objectContaining(GRUPO));
    });

    it('rechaza una baja sin origen o sin alertaId', async () => {
      const handler = createDarDeBajaContextosClimaticosHandler({ contextoZonaRepository: contextoRepo() });
      await expect(handler(client(), { alertaId: ALERTA.alertaId })).rejects.toThrow('origen y alertaId');
      await expect(handler(client(), undefined)).rejects.toThrow('origen y alertaId');
    });

    it('rechaza un alta sin ubicaciones, sin radio o con un punto inválido', async () => {
      const handler = createRegistrarContextosClimaticosHandler({ contextoZonaRepository: contextoRepo() });
      await expect(handler(client(), { ...base, ubicaciones: [] })).rejects.toThrow('ubicación');
      await expect(handler(client(), { ...base, radioMetros: null })).rejects.toThrow('radioMetros');
      await expect(handler(client(), { ...base, ubicaciones: [{ indice: -1, latitud: 1, longitud: 1 }] }))
        .rejects.toThrow('índice, latitud y longitud');
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
