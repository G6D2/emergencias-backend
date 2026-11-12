const request = require('supertest');
const { createApp } = require('../app');
const { ESTADO_CONTEXTO, estadoDelContexto } = require('../domain/contexto-zona');
const { ContextoZonaRepository } = require('../repositories/contexto-zona.repository');
const { EventosProcesadosRepository } = require('../repositories/eventos-procesados.repository');

const mockKafkaService = { publishEvent: async () => {}, isConnected: () => true, checkHealth: async () => false };
const HORA = 60 * 60 * 1000;

function authenticateAs(groups) {
  return (req, res, next) => {
    req.user = { sub: 'U000999', groups, username: 'operador1' };
    next();
  };
}

function contexto(overrides = {}) {
  return {
    id: 'ctx-1',
    tipo: 'EVENTO_ESPACIO_PUBLICO',
    referenciaExterna: 'ev-1',
    descripcion: 'Recital en el Rosedal',
    latitud: -34.5711,
    longitud: -58.4167,
    radioMetros: 500,
    vigenteDesde: new Date(Date.now() - HORA),
    vigenteHasta: new Date(Date.now() + HORA),
    suspendidoEn: null,
    dadoDeBajaEn: null,
    emergenciasVinculadas: 2,
    ...overrides,
  };
}

describe('estadoDelContexto', () => {
  const ahora = new Date('2026-11-21T20:00:00Z');
  const base = {
    latitud: -34.57, longitud: -58.41,
    vigenteDesde: '2026-11-21T18:00:00Z', vigenteHasta: '2026-11-21T23:00:00Z',
    suspendidoEn: null, dadoDeBajaEn: null,
  };

  it('en curso dentro de la ventana; programado antes; finalizado después', () => {
    expect(estadoDelContexto(base, ahora)).toBe(ESTADO_CONTEXTO.EN_CURSO);
    expect(estadoDelContexto(base, new Date('2026-11-21T17:59:59Z'))).toBe(ESTADO_CONTEXTO.PROGRAMADO);
    expect(estadoDelContexto(base, new Date('2026-11-21T23:00:00Z'))).toBe(ESTADO_CONTEXTO.FINALIZADO);
  });

  it('la baja le gana a todo; la suspensión a la ventana', () => {
    expect(estadoDelContexto({ ...base, suspendidoEn: ahora }, ahora)).toBe(ESTADO_CONTEXTO.SUSPENDIDO);
    expect(estadoDelContexto({ ...base, suspendidoEn: ahora, dadoDeBajaEn: ahora }, ahora)).toBe(ESTADO_CONTEXTO.DADO_DE_BAJA);
  });

  it('un contexto sin punto (anterior a V31) no está en curso', () => {
    expect(estadoDelContexto({ ...base, latitud: null, longitud: null }, ahora)).toBe(ESTADO_CONTEXTO.SIN_PUNTO);
  });

  it('sin instante usa ahora', () => {
    expect(estadoDelContexto(contexto())).toBe(ESTADO_CONTEXTO.EN_CURSO);
  });
});

describe('GET /api/zone-contexts', () => {
  it('lista los contextos con su estado para el dispatcher', async () => {
    const contextoZonaRepository = {
      findRecent: jest.fn().mockResolvedValue([
        contexto(),
        contexto({ id: 'ctx-2', referenciaExterna: 'ev-2', vigenteHasta: new Date(Date.now() - 1000), emergenciasVinculadas: 0 }),
      ]),
    };
    const app = createApp(mockKafkaService, {}, { authenticate: authenticateAs(['dispatcher']), contextoZonaRepository });

    const response = await request(app).get('/api/zone-contexts').expect(200);

    expect(contextoZonaRepository.findRecent).toHaveBeenCalledWith({ limit: 50 });
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]).toMatchObject({
      referenciaExterna: 'ev-1', radioMetros: 500, estado: 'EN_CURSO', emergenciasVinculadas: 2,
    });
    expect(response.body.data[1].estado).toBe('FINALIZADO');
  });

  it('acota limit entre 1 y 100', async () => {
    const contextoZonaRepository = { findRecent: jest.fn().mockResolvedValue([]) };
    const app = createApp(mockKafkaService, {}, { authenticate: authenticateAs(['dispatcher']), contextoZonaRepository });

    await request(app).get('/api/zone-contexts?limit=500').expect(200);
    await request(app).get('/api/zone-contexts?limit=-3').expect(200);
    await request(app).get('/api/zone-contexts?limit=abc').expect(200);

    expect(contextoZonaRepository.findRecent.mock.calls.map(([arg]) => arg.limit)).toEqual([100, 1, 50]);
  });

  it('rechaza a quien no es dispatcher', async () => {
    const contextoZonaRepository = { findRecent: jest.fn() };
    const app = createApp(mockKafkaService, {}, { authenticate: authenticateAs(['citizen']), contextoZonaRepository });

    await request(app).get('/api/zone-contexts').expect(403);
    expect(contextoZonaRepository.findRecent).not.toHaveBeenCalled();
  });

  it('sin repositorio la ruta no existe', async () => {
    const app = createApp(mockKafkaService, {}, { authenticate: authenticateAs(['dispatcher']) });
    await request(app).get('/api/zone-contexts').expect(404);
    await request(app).get('/api/received-events').expect(404);
  });
});

describe('GET /api/received-events', () => {
  const evento = {
    eventId: 'a1000000-0000-4000-8000-000000000001',
    source: 'grupo7',
    eventType: 'com.citypass.espacios.EventoComunitarioPublicado',
    status: 'PROCESSED',
    discardReason: null,
    processedAt: new Date('2026-11-21T18:00:00Z'),
    contextoReferencia: 'ev-1',
  };

  it('lista los eventos recibidos para el dispatcher', async () => {
    const eventosProcesadosRepository = { findRecent: jest.fn().mockResolvedValue([evento]) };
    const app = createApp(mockKafkaService, {}, { authenticate: authenticateAs(['dispatcher']), eventosProcesadosRepository });

    const response = await request(app).get('/api/received-events?limit=10').expect(200);

    expect(eventosProcesadosRepository.findRecent).toHaveBeenCalledWith({ limit: 10 });
    expect(response.body.data).toEqual([{ ...evento, processedAt: '2026-11-21T18:00:00.000Z' }]);
  });

  it('rechaza a quien no es dispatcher', async () => {
    const eventosProcesadosRepository = { findRecent: jest.fn() };
    const app = createApp(mockKafkaService, {}, { authenticate: authenticateAs(['officer']), eventosProcesadosRepository });

    await request(app).get('/api/received-events').expect(403);
    expect(eventosProcesadosRepository.findRecent).not.toHaveBeenCalled();
  });
});

describe('repositorios: findRecent', () => {
  it('ContextoZonaRepository trae los más recientes con la cuenta de vínculos', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 'ctx-1', referencia_externa: 'ev-1', latitud: -34.57, longitud: -58.41, radio_metros: 500, emergencias_vinculadas: 3 }],
      }),
    };

    const [fila] = await new ContextoZonaRepository(pool).findRecent({ limit: 7 });

    expect(fila).toMatchObject({ id: 'ctx-1', referenciaExterna: 'ev-1', radioMetros: 500, emergenciasVinculadas: 3 });
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FROM emergencia_contexto_zona ecz WHERE ecz\.contexto_id = c\.id/);
    expect(sql).toMatch(/ORDER BY c\.updated_at DESC/);
    expect(values).toEqual([7]);
    await new ContextoZonaRepository(pool).findRecent();
    expect(pool.query.mock.calls[1][1]).toEqual([50]);
  });

  it('EventosProcesadosRepository trae el resultado y el contexto que escribió, sin el contenido', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          { event_id: 'e-1', source: 'grupo7', event_type: 'T', status: 'PROCESSED', discard_reason: null, processed_at: new Date(0), contexto_referencia: 'ev-1' },
          { event_id: 'e-2', source: 'grupo7', event_type: 'T', status: 'DISCARDED', discard_reason: 'payload inválido', processed_at: new Date(0) },
        ],
      }),
    };

    const filas = await new EventosProcesadosRepository(pool).findRecent({ limit: 2 });

    expect(filas[0]).toEqual({
      eventId: 'e-1', source: 'grupo7', eventType: 'T', status: 'PROCESSED', discardReason: null, processedAt: new Date(0), contextoReferencia: 'ev-1',
    });
    expect(filas[1]).toMatchObject({ status: 'DISCARDED', discardReason: 'payload inválido', contextoReferencia: null });
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/LEFT JOIN contexto_zona c ON c\.causation_id = e\.event_id/);
    expect(values).toEqual([2]);
    await new EventosProcesadosRepository(pool).findRecent();
    expect(pool.query.mock.calls[1][1]).toEqual([50]);
  });
});
