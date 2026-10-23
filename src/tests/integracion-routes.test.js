const request = require('supertest');
const { createApp } = require('../app');
const { buildIntegracionManual } = require('../integracion/bootstrap');
const { MENSAJE } = require('../disparadores/evento-publico/respuestas/elevar-prioridad');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

const DISPATCHER = { sub: 'DISP-001', groups: ['dispatcher'] };
const CITIZEN = { sub: 'CIT-001', groups: ['citizen'] };

function stubAuthenticate(user) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

// Pool en memoria: simula ON CONFLICT DO NOTHING de eventos_procesados.
function createMockPool() {
  const procesados = new Set();
  const client = {
    query: jest.fn(async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO eventos_procesados')) {
        const [eventId] = params;
        if (procesados.has(eventId)) return { rowCount: 0, rows: [] };
        procesados.add(eventId);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }),
    release: jest.fn(),
  };
  return { connect: jest.fn(async () => client), query: jest.fn(), client };
}

function createTestApp(user, pool = createMockPool()) {
  const integracionHandler = buildIntegracionManual({
    pool,
    locationCrypto: { encryptLocation: jest.fn(() => 'cipher') },
    env: {},
  });
  return createApp(mockKafkaService, {}, {
    authenticate: stubAuthenticate(user),
    integracionHandler,
  });
}

const eventoPublico = (eventId) => ({
  metadata: {
    eventId,
    eventType: 'com.citypass.espacios.EventoComunitarioPublicado',
    source: 'com.citypass.espacios',
  },
  data: { nombre: 'Feria del barrio', capacidad: 100 },
});

describe('POST /api/integracion/eventos', () => {
  let logSpy;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => logSpy.mockRestore());

  it('pasa el evento por el listener y ejecuta el disparador', async () => {
    const res = await request(createTestApp(DISPATCHER))
      .post('/api/integracion/eventos')
      .send(eventoPublico('prueba-1'))
      .expect(200);

    expect(res.body).toEqual({ eventId: 'prueba-1', processed: true, commandCount: 1 });
    expect(logSpy).toHaveBeenCalledWith(MENSAJE);
  });

  it('descarta un eventId repetido por dedup', async () => {
    const app = createTestApp(DISPATCHER);
    await request(app).post('/api/integracion/eventos').send(eventoPublico('dup')).expect(200);
    logSpy.mockClear();

    const res = await request(app).post('/api/integracion/eventos').send(eventoPublico('dup')).expect(200);

    expect(res.body).toMatchObject({ eventId: 'dup', discarded: true, reason: 'duplicate' });
    expect(logSpy).not.toHaveBeenCalledWith(MENSAJE);
  });

  it('genera un eventId si no viene', async () => {
    const body = eventoPublico();
    delete body.metadata.eventId;

    const res = await request(createTestApp(DISPATCHER))
      .post('/api/integracion/eventos')
      .send(body)
      .expect(200);

    expect(res.body.eventId).toEqual(expect.any(String));
    expect(res.body.processed).toBe(true);
  });

  it('400 sin metadata.eventType', async () => {
    await request(createTestApp(DISPATCHER))
      .post('/api/integracion/eventos')
      .send({ metadata: {}, data: {} })
      .expect(400);
  });

  it('400 si data no es un objeto', async () => {
    await request(createTestApp(DISPATCHER))
      .post('/api/integracion/eventos')
      .send({ metadata: { eventType: 'EventoComunitarioPublicado' }, data: [] })
      .expect(400);
  });

  it('403 para un ciudadano', async () => {
    await request(createTestApp(CITIZEN))
      .post('/api/integracion/eventos')
      .send(eventoPublico('x'))
      .expect(403);
  });
});
