// GET /api/contextos-zona/activos: el endpoint que consulta cada 60 s el
// banner de alertas climáticas del tablero. Prueba la puerta (quién puede
// preguntar y qué pasa con un pedido mal armado) y la respuesta, con JWT
// local real (el mismo `authenticate` que en producción) y el repositorio
// mockeado. La matriz de autorización también cubre esta ruta en los dos
// modos de auth; acá están los casos explícitos y legibles.

const request = require('supertest');
const { createApp } = require('../app');
const { createLocalJwtAuth } = require('./helpers/local-jwt');

const ROUTE = '/api/contextos-zona/activos';
const KAFKA_APAGADO = { isEnabled: () => false, checkHealth: async () => false };

const ALERTA_ALTA = {
  id: 'ctx-1',
  referenciaExterna: 'f6029e4f-e0ef-46b8-9f1a-66e814f1c90e',
  tipo: 'ALERTA_CLIMATICA',
  fenomeno: 'OLA_DE_CALOR',
  gravedad: 'ALTA',
  tiposEmergencia: ['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA'],
  barrios: ['BALVANERA', 'SAN NICOLAS'],
  descripcion: null,
  latitud: null,
  longitud: null,
  radioMetros: null,
  causationId: '3c9a7d21-5b6e-4f80-9a1b-2c3d4e5f6a7b',
  vigenteDesde: new Date('2026-11-13T21:00:00Z'),
  vigenteHasta: new Date('2026-11-14T06:00:00Z'),
};
const ALERTA_LEVE = {
  ...ALERTA_ALTA,
  id: 'ctx-2',
  referenciaExterna: '0b0e5c1a-7f3e-4a8e-9a51-2d5f1c7e9b10',
  fenomeno: 'GRANIZO',
  gravedad: 'LEVE',
  tiposEmergencia: [],
  barrios: ['RECOLETA'],
};

let auth;
let bearers;

beforeAll(async () => {
  auth = await createLocalJwtAuth();
  bearers = {
    dispatcher: await auth.bearerFor({ sub: 'DISP-banner', groups: ['dispatcher'] }),
    citizen: await auth.bearerFor({ sub: 'CIT-banner', groups: ['citizen'] }),
    officer: await auth.bearerFor({ sub: 'of-001', groups: ['officer'] }),
  };
});

function appWith(contextoZonaRepository) {
  return createApp(KAFKA_APAGADO, {}, { authenticate: auth.authenticate, contextoZonaRepository });
}

function repoCon(contextos = [ALERTA_ALTA, ALERTA_LEVE]) {
  return { findActivos: jest.fn(async () => contextos) };
}

describe('GET /api/contextos-zona/activos — la puerta', () => {
  it('sin login: 401 y no consulta la base', async () => {
    const repo = repoCon();
    const res = await request(appWith(repo)).get(`${ROUTE}?tipo=ALERTA_CLIMATICA`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UnauthorizedError');
    expect(repo.findActivos).not.toHaveBeenCalled();
  });

  it('con un token que no es JWT: 401 y no consulta la base', async () => {
    const repo = repoCon();
    const res = await request(appWith(repo)).get(ROUTE).set('Authorization', 'Bearer no-es-un-jwt');

    expect(res.status).toBe(401);
    expect(repo.findActivos).not.toHaveBeenCalled();
  });

  it.each(['citizen', 'officer'])('un %s: 403 y no consulta la base', async (identidad) => {
    const repo = repoCon();
    const res = await request(appWith(repo)).get(`${ROUTE}?tipo=ALERTA_CLIMATICA`).set('Authorization', bearers[identidad]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ForbiddenError');
    expect(repo.findActivos).not.toHaveBeenCalled();
  });

  it.each([
    ['un tipo que no existe', '?tipo=FIESTA'],
    ['un tipo vacío', '?tipo='],
    ['el tipo repetido', '?tipo=ALERTA_CLIMATICA&tipo=EVENTO_ESPACIO_PUBLICO'],
  ])('un dispatcher con %s: 400 (pedido inválido) y no consulta la base', async (_caso, query) => {
    const repo = repoCon();
    const res = await request(appWith(repo)).get(`${ROUTE}${query}`).set('Authorization', bearers.dispatcher);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
    expect(res.body.message).toMatch(/tipo inválido: debe ser uno de EVENTO_ESPACIO_PUBLICO, ALERTA_CLIMATICA/);
    expect(repo.findActivos).not.toHaveBeenCalled();
  });

  it('sin el repositorio configurado, la ruta no existe (404)', async () => {
    const res = await request(createApp(KAFKA_APAGADO, {}, { authenticate: auth.authenticate }))
      .get(ROUTE)
      .set('Authorization', bearers.dispatcher);

    expect(res.status).toBe(404);
  });
});

describe('GET /api/contextos-zona/activos — la respuesta al dispatcher', () => {
  it('200 con las alertas activas, el tipo normalizado y eleva según los tipos', async () => {
    const repo = repoCon();
    const res = await request(appWith(repo)).get(`${ROUTE}?tipo=alerta_climatica`).set('Authorization', bearers.dispatcher);

    expect(res.status).toBe(200);
    expect(repo.findActivos).toHaveBeenCalledWith(null, { tipo: 'ALERTA_CLIMATICA' });
    expect(res.body).toEqual({
      data: [
        {
          referenciaExterna: ALERTA_ALTA.referenciaExterna,
          tipo: 'ALERTA_CLIMATICA',
          fenomeno: 'OLA_DE_CALOR',
          gravedad: 'ALTA',
          eleva: true,
          tiposEmergencia: ['MEDICA', 'INCENDIO', 'INFRAESTRUCTURA'],
          barrios: ['BALVANERA', 'SAN NICOLAS'],
          descripcion: null,
          vigenteDesde: '2026-11-13T21:00:00.000Z',
          vigenteHasta: '2026-11-14T06:00:00.000Z',
        },
        expect.objectContaining({ referenciaExterna: ALERTA_LEVE.referenciaExterna, gravedad: 'LEVE', eleva: false }),
      ],
    });
  });

  it('no expone ids internos, coordenadas ni trazabilidad', async () => {
    const res = await request(appWith(repoCon())).get(ROUTE).set('Authorization', bearers.dispatcher);

    for (const contexto of res.body.data) {
      for (const campo of ['id', 'latitud', 'longitud', 'radioMetros', 'causationId']) {
        expect(contexto).not.toHaveProperty(campo);
      }
    }
  });

  it('sin tipo devuelve todos (consulta con tipo null); sin alertas, data vacía', async () => {
    const repo = repoCon([]);
    const res = await request(appWith(repo)).get(ROUTE).set('Authorization', bearers.dispatcher);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
    expect(repo.findActivos).toHaveBeenCalledWith(null, { tipo: null });
  });

  it('si la base falla: 500 con un mensaje genérico, sin el error interno', async () => {
    const repo = { findActivos: jest.fn(async () => { throw new Error('connection terminated: password=secreta'); }) };
    const res = await request(appWith(repo)).get(ROUTE).set('Authorization', bearers.dispatcher);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'InternalServerError', message: 'Error interno' });
    expect(JSON.stringify(res.body)).not.toMatch(/secreta|connection/);
  });
});
