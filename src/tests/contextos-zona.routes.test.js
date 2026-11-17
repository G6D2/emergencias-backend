// GET /api/contextos-zona/activos: el endpoint que consulta cada 60 s el
// banner de alertas climáticas del tablero. Prueba la puerta (quién puede
// preguntar) y la respuesta (una entrada por alerta), con JWT
// local real (el mismo `authenticate` que en producción) y el repositorio
// mockeado. La matriz de autorización también cubre esta ruta en los dos
// modos de auth; acá están los casos explícitos y legibles.

const request = require('supertest');
const { createApp } = require('../app');
const { createLocalJwtAuth } = require('./helpers/local-jwt');

const ROUTE = '/api/contextos-zona/activos';
const KAFKA_APAGADO = { isEnabled: () => false, checkHealth: async () => false };

// Lo que devuelve findActivos: un contexto por punto de la alerta (referencia
// <alertaId>#<índice>), como los registra el listener del ADR #39.
const ALERTA_ID = 'f6029e4f-e0ef-46b8-9f1a-66e814f1c90e';
const PUNTO = {
  id: 'ctx-1',
  tipo: 'ALERTA_CLIMATICA',
  origen: 'espacios',
  referenciaExterna: `${ALERTA_ID}#0`,
  nivelCriticidad: 'ALTA',
  fenomeno: 'OLA_DE_CALOR',
  barrios: ['BALVANERA', 'SAN NICOLAS'],
  descripcion: 'Alerta climática ALTA: ola de calor',
  latitud: -34.6037,
  longitud: -58.3816,
  radioMetros: 500,
  causationId: '3c9a7d21-5b6e-4f80-9a1b-2c3d4e5f6a7b',
  vigenteDesde: new Date('2026-11-13T21:00:00Z'),
  vigenteHasta: new Date('2026-11-14T06:00:00Z'),
  enCurso: true,
};
const SEGUNDO_PUNTO = {
  ...PUNTO, id: 'ctx-2', referenciaExterna: `${ALERTA_ID}#1`, latitud: -34.6090, longitud: -58.3920,
};
const CRITICA_PROGRAMADA = {
  ...PUNTO,
  id: 'ctx-3',
  referenciaExterna: '0b0e5c1a-7f3e-4a8e-9a51-2d5f1c7e9b10#0',
  nivelCriticidad: 'CRITICA',
  fenomeno: 'GRANIZO',
  barrios: ['RECOLETA'],
  descripcion: 'Alerta climática CRITICA: granizo',
  radioMetros: 1000,
  vigenteDesde: new Date('2026-11-14T03:00:00Z'),
  enCurso: false,
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

function repoCon(contextos = [PUNTO, SEGUNDO_PUNTO, CRITICA_PROGRAMADA]) {
  return { findActivos: jest.fn(async () => contextos) };
}

describe('GET /api/contextos-zona/activos — la puerta', () => {
  it('sin login: 401 y no consulta la base', async () => {
    const repo = repoCon();
    const res = await request(appWith(repo)).get(ROUTE);

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
    const res = await request(appWith(repo)).get(ROUTE).set('Authorization', bearers[identidad]);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ForbiddenError');
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
  it('200 con una entrada por alerta (no por punto), primero las CRITICA', async () => {
    const repo = repoCon();
    const res = await request(appWith(repo)).get(ROUTE).set('Authorization', bearers.dispatcher);

    expect(res.status).toBe(200);
    expect(repo.findActivos).toHaveBeenCalledWith(null, { tipo: 'ALERTA_CLIMATICA' });
    expect(res.body).toEqual({
      data: [
        {
          alertaId: '0b0e5c1a-7f3e-4a8e-9a51-2d5f1c7e9b10',
          nivel: 'CRITICA',
          fenomeno: 'GRANIZO',
          fenomenoEtiqueta: 'Granizo',
          barrios: ['RECOLETA'],
          vigenteDesde: '2026-11-14T03:00:00.000Z',
          vigenteHasta: '2026-11-14T06:00:00.000Z',
          enCurso: false,
          puntos: 1,
          radioMetros: 1000,
          descripcion: 'Alerta climática CRITICA: granizo',
        },
        {
          alertaId: ALERTA_ID,
          nivel: 'ALTA',
          fenomeno: 'OLA_DE_CALOR',
          fenomenoEtiqueta: 'Ola de calor',
          barrios: ['BALVANERA', 'SAN NICOLAS'],
          vigenteDesde: '2026-11-13T21:00:00.000Z',
          vigenteHasta: '2026-11-14T06:00:00.000Z',
          enCurso: true,
          puntos: 2,
          radioMetros: 500,
          descripcion: 'Alerta climática ALTA: ola de calor',
        },
      ],
    });
  });

  it('no expone ids internos, coordenadas ni trazabilidad', async () => {
    const res = await request(appWith(repoCon())).get(ROUTE).set('Authorization', bearers.dispatcher);

    for (const alerta of res.body.data) {
      for (const campo of ['id', 'latitud', 'longitud', 'causationId', 'referenciaExterna', 'origen']) {
        expect(alerta).not.toHaveProperty(campo);
      }
    }
  });

  it('ignora query params (ya no hay filtro por tipo); sin alertas, data vacía', async () => {
    const repo = repoCon([]);
    const res = await request(appWith(repo)).get(`${ROUTE}?tipo=EVENTO_ESPACIO_PUBLICO`).set('Authorization', bearers.dispatcher);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
    expect(repo.findActivos).toHaveBeenCalledWith(null, { tipo: 'ALERTA_CLIMATICA' });
  });

  it('si la base falla: 500 con un mensaje genérico, sin el error interno', async () => {
    const repo = { findActivos: jest.fn(async () => { throw new Error('connection terminated: password=secreta'); }) };
    const res = await request(appWith(repo)).get(ROUTE).set('Authorization', bearers.dispatcher);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'InternalServerError', message: 'Error interno' });
    expect(JSON.stringify(res.body)).not.toMatch(/secreta|connection/);
  });
});
