jest.mock('../../security/secure-log', () => ({ secureLog: jest.fn() }));

const path = require('path');
const { EventListener, createListeners } = require('../../listeners');
const { EmergenciaSolicitadaListener } = require('../../listeners/reclamo-intervencion');
const {
  EmergenciaBicicletaListener,
} = require('../../listeners/movilidad-bicicleta');
const {
  CrearEmergenciaBicicletaRule,
} = require('../../listeners/movilidad-bicicleta/emergencia-bicicleta/rules/01-crear-emergencia-bicicleta.rule');
const {
  CAUSA_TIPO,
  CREAR_EMERGENCIA_BICICLETA,
  createCrearEmergenciaBicicletaHandler,
} = require('../../listeners/movilidad-bicicleta/handlers/crear-emergencia-bicicleta.handler');
const { buildEmergencyUpdatedEvent } = require('../../services/emergency-events');

const kafka = { consumer: jest.fn() };
const EMERGENCIA = {
  emergenciaId: 'EMG-20261115-12345',
  latitud: -34.6037,
  longitud: -58.3816,
  prioridadSugerida: 'P1',
  triage: {
    respondido: true,
    puedeMoverse: false,
    estaSangrando: true,
    vehiculoInvolucrado: true,
  },
  viajeId: 101,
  bicicletaCodigo: 'BIKE-0055',
};

function repository(existing = []) {
  return {
    findByCausa: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockResolvedValue({}),
  };
}

describe('listener EmergenciaBicicleta', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('se registra sin reemplazar EmergenciaSolicitada', () => {
    const constructors = createListeners(kafka).map((listener) => listener.constructor);
    expect(constructors).toEqual(expect.arrayContaining([
      EmergenciaBicicletaListener,
      EmergenciaSolicitadaListener,
    ]));
  });

  it('usa su topic propio y carga su regla', () => {
    delete process.env.EDA_TOPIC_EMERGENCIA_BICICLETA;
    const listener = new EmergenciaBicicletaListener(kafka);
    expect(listener).toBeInstanceOf(EventListener);
    expect(listener.topic).toBe('com.citypass.movilidad.EmergenciaBicicleta');
    expect(listener.rulesDir).toBe(path.join(
      __dirname,
      '../../listeners/movilidad-bicicleta/emergencia-bicicleta/rules'
    ));
    expect(listener.rules().map((rule) => rule.constructor)).toEqual([CrearEmergenciaBicicletaRule]);

    process.env.EDA_TOPIC_EMERGENCIA_BICICLETA = 'otro.EmergenciaBicicleta';
    expect(new EmergenciaBicicletaListener(kafka).topic).toBe('otro.EmergenciaBicicleta');
  });
});

describe('CrearEmergenciaBicicletaRule', () => {
  const rule = new CrearEmergenciaBicicletaRule();

  it('mapea los campos operativos y omite los datos personales', () => {
    const result = rule.apply({ data: {
      emergenciaId: EMERGENCIA.emergenciaId,
      ubicacion: { latitud: EMERGENCIA.latitud, longitud: EMERGENCIA.longitud },
      triage: { ...EMERGENCIA.triage, prioridadSugerida: 'P1' },
      viaje: { viajeId: 101, bicicletaCodigo: 'BIKE-0055' },
      actorSub: 'no-se-persiste',
      usuario: { email: 'demo@example.invalid' },
    } });

    expect(rule.appliesTo({ data: {} })).toBe(true);
    expect(result).toEqual({ type: CREAR_EMERGENCIA_BICICLETA, payload: EMERGENCIA });
  });

  it.each([
    [{ emergenciaId: '' }, /emergenciaId/],
    [{ emergenciaId: 'EMG-1', ubicacion: { latitud: 91, longitud: 0 }, triage: { prioridadSugerida: 'P1' } }, /coordenadas/],
    [{ emergenciaId: 'EMG-1', ubicacion: { latitud: 0, longitud: 0 }, triage: { prioridadSugerida: 'P5' } }, /prioridadSugerida/],
  ])('rechaza payload inválido', (data, error) => {
    expect(() => rule.apply({ data })).toThrow(error);
  });
});

describe('createCrearEmergenciaBicicletaHandler', () => {
  const client = { query: jest.fn().mockResolvedValue({}) };

  it('crea MEDICA pendiente y conserva el ID externo como correlación y causa', async () => {
    const emergencyRepository = repository();
    const handler = createCrearEmergenciaBicicletaHandler({
      emergencyRepository,
      topic: 'test.emergencias.creada',
    });

    const result = await handler(client, EMERGENCIA);

    expect(result.created).toBe(true);
    expect(emergencyRepository.findByCausa).toHaveBeenCalledWith(client, {
      causaTipo: CAUSA_TIPO,
      causaId: EMERGENCIA.emergenciaId,
    });
    const input = emergencyRepository.create.mock.calls[0][0];
    expect(input).toMatchObject({
      client,
      correlationId: EMERGENCIA.emergenciaId,
      userId: null,
      latitude: EMERGENCIA.latitud,
      longitude: EMERGENCIA.longitud,
      severity: 'critical',
      emergencyType: 'MEDICA',
      status: 'PENDING',
      source: 'EXTERNAL',
      requiresManualValidation: false,
      causaTipo: CAUSA_TIPO,
      causaId: EMERGENCIA.emergenciaId,
    });
    expect(input.description).toContain('BIKE-0055');
    expect(input.outboxEvent.topic).toBe('test.emergencias.creada');

    const event = input.outboxEvent.payload({
      ...input,
      barrio: 'PALERMO',
      createdAt: '2026-11-15T12:00:00.000Z',
    }, 'evt-created');
    expect(event).toMatchObject({
      type: 'EmergenciaCreada',
      correlationId: EMERGENCIA.emergenciaId,
      data: {
        correlationId: EMERGENCIA.emergenciaId,
        categoria: 'MEDICA',
        prioridad: 'CRITICA',
        causaTipo: CAUSA_TIPO,
        causaId: EMERGENCIA.emergenciaId,
      },
    });
    expect(event.data.emergenciaId).toBe(result.emergencyId);
    expect(event.data.emergenciaId).not.toBe(EMERGENCIA.emergenciaId);

    const updated = buildEmergencyUpdatedEvent({
      emergency: { ...input, id: result.emergencyId },
      history: { previousStatus: 'PENDING', newStatus: 'VALIDATED' },
      eventId: 'evt-updated',
    });
    expect(updated.correlationId).toBe(EMERGENCIA.emergenciaId);
    expect(updated.data.correlationId).toBe(EMERGENCIA.emergenciaId);
  });

  it.each([
    ['P1', 'critical'],
    ['P2', 'high'],
    ['P3', 'medium'],
    ['P4', 'low'],
  ])('mapea prioridad %s a severidad %s', async (prioridadSugerida, severity) => {
    const emergencyRepository = repository();
    const handler = createCrearEmergenciaBicicletaHandler({ emergencyRepository });

    await handler(client, { ...EMERGENCIA, prioridadSugerida });

    expect(emergencyRepository.create.mock.calls[0][0].severity).toBe(severity);
  });

  it('no crea otra emergencia si ya existe la causa externa', async () => {
    const emergencyRepository = repository([{ id: 'existing-id', status: 'PENDING' }]);
    const handler = createCrearEmergenciaBicicletaHandler({ emergencyRepository });

    await expect(handler(client, EMERGENCIA)).resolves.toEqual({
      emergencyId: 'existing-id',
      created: false,
    });
    expect(emergencyRepository.create).not.toHaveBeenCalled();
  });

  it('resuelve una carrera con el índice único por causa', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uq_emergencies_movilidad_bicicleta_causa',
    });
    const emergencyRepository = {
      findByCausa: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'winner-id', status: 'PENDING' }]),
      create: jest.fn().mockRejectedValue(duplicate),
    };
    const handler = createCrearEmergenciaBicicletaHandler({ emergencyRepository });

    await expect(handler(client, EMERGENCIA)).resolves.toEqual({
      emergencyId: 'winner-id',
      created: false,
    });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT crear_emergencia_bicicleta');
  });
});
