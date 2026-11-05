const request = require('supertest');
const { createApp } = require('../app');
const { NotFoundError } = require('../errors/app-errors');
const { canAdvanceEmergencyStatus } = require('../auth/authorize');
const { resolveDevLoginClaims, DEV_LOGIN_ALLOWLIST } = require('../auth/dev-login-policy');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

const EMERGENCY_ID = '3f2b1c6e-5d4a-4b8e-9c1d-0a1b2c3d4e5f';
const OFFICER = { sub: 'of-001', groups: ['officer'] };
const OTHER_OFFICER = { sub: 'of-002', groups: ['officer'] };

function stubAuthenticate(user) {
  return (req, res, next) => {
    if (user) req.user = user;
    next();
  };
}

// Repo en memoria. Espeja del repo real lo que importa acá: guarda el oficial
// con el que se hizo el lock y el outboxEvent recibido. La transacción SQL, el
// lock y el historial reales están en operational-status.integration.test.js.
function createMockRepository(initial = {}) {
  const emergencies = new Map();
  emergencies.set(EMERGENCY_ID, {
    id: EMERGENCY_ID,
    userId: 'U1',
    status: 'DISPATCHED',
    assignedOfficerId: 'of-001',
    ...initial,
  });
  const updateCalls = [];

  return {
    updateCalls,
    findById: jest.fn(async (id) => emergencies.get(id) || null),
    updateStatus: jest.fn(async (id, options) => {
      updateCalls.push({ id, ...options });
      const current = emergencies.get(id);
      if (!current) throw new NotFoundError(`Emergency with ID ${id} not found`);
      if (options.requireAssignedOfficerId != null
        && current.assignedOfficerId !== options.requireAssignedOfficerId) {
        throw new NotFoundError(`Emergency with ID ${id} not found`);
      }
      const updated = { ...current, status: options.newStatus };
      emergencies.set(id, updated);
      return {
        emergency: updated,
        history: {
          previousStatus: current.status,
          newStatus: options.newStatus,
          actor: options.actor,
          reason: options.reason ?? null,
        },
      };
    }),
  };
}

function buildApp(repository, user = OFFICER) {
  return createApp(mockKafkaService, repository, { authenticate: stubAuthenticate(user) });
}

describe('canAdvanceEmergencyStatus', () => {
  it('permite al oficial cuyo sub es el oficial asignado', () => {
    expect(canAdvanceEmergencyStatus(OFFICER, { assignedOfficerId: 'of-001' })).toBe(true);
  });

  it.each([
    ['otro oficial', OTHER_OFFICER, { assignedOfficerId: 'of-001' }],
    ['emergencia sin oficial asignado', OFFICER, { assignedOfficerId: null }],
    ['emergencia sin el campo', OFFICER, {}],
    ['dispatcher aunque el sub coincida', { sub: 'of-001', groups: ['dispatcher'] }, { assignedOfficerId: 'of-001' }],
    ['citizen aunque el sub coincida', { sub: 'of-001', groups: ['citizen'] }, { assignedOfficerId: 'of-001' }],
    ['usuario sin grupos', { sub: 'of-001', groups: [] }, { assignedOfficerId: 'of-001' }],
    ['sub vacío contra oficial vacío', { sub: '', groups: ['officer'] }, { assignedOfficerId: '' }],
  ])('rechaza: %s', (_name, user, emergency) => {
    expect(canAdvanceEmergencyStatus(user, emergency)).toBe(false);
  });
});

describe('login de desarrollo: grupo officer', () => {
  it('modo laxo acepta el grupo officer y conserva el sub elegido', () => {
    const claims = resolveDevLoginClaims({ sub: 'of-003', groups: ['officer'] }, { NODE_ENV: 'test' });
    expect(claims.groups).toEqual(['officer']);
    expect(claims.sub).toBe('of-003');
  });

  it('modo estricto emite officer solo para los oficiales demo, con grupos fijos', () => {
    const claims = resolveDevLoginClaims(
      { sub: 'of-001', groups: ['dispatcher'] },
      { NODE_ENV: 'production' }
    );
    expect(claims.groups).toEqual(['officer']);
    expect(Object.keys(DEV_LOGIN_ALLOWLIST)).toEqual(expect.arrayContaining(['of-001', 'of-002']));
  });

  it('modo estricto rechaza un oficial que no está en la allowlist', () => {
    expect(() => resolveDevLoginClaims({ sub: 'of-999', groups: ['officer'] }, { NODE_ENV: 'production' }))
      .toThrow(/not allowed/);
  });
});

describe('PATCH acciones de estado operativo del oficial', () => {
  it('recorre DISPATCHED → EN_ROUTE → ON_SCENE → RESOLVED', async () => {
    const repository = createMockRepository();
    const app = buildApp(repository);

    const enRoute = await request(app).patch(`/api/emergencies/${EMERGENCY_ID}/en-route`).expect(200);
    expect(enRoute.body).toMatchObject({ success: true, data: { status: 'EN_ROUTE' } });

    const onScene = await request(app).patch(`/api/emergencies/${EMERGENCY_ID}/on-scene`).expect(200);
    expect(onScene.body.data.status).toBe('ON_SCENE');

    const resolved = await request(app).patch(`/api/emergencies/${EMERGENCY_ID}/resolve`).expect(200);
    expect(resolved.body.data.status).toBe('RESOLVED');

    expect(repository.updateCalls.map((c) => c.newStatus)).toEqual(['EN_ROUTE', 'ON_SCENE', 'RESOLVED']);
  });

  it('registra al oficial como actor y lo pasa al lock del repositorio', async () => {
    const repository = createMockRepository();

    await request(buildApp(repository)).patch(`/api/emergencies/${EMERGENCY_ID}/en-route`).expect(200);

    expect(repository.updateCalls[0]).toMatchObject({
      id: EMERGENCY_ID,
      newStatus: 'EN_ROUTE',
      actor: 'of-001',
      requireAssignedOfficerId: 'of-001',
    });
  });

  it('publica EmergenciaActualizada con el cambio de estado', async () => {
    const repository = createMockRepository();

    await request(buildApp(repository)).patch(`/api/emergencies/${EMERGENCY_ID}/en-route`).expect(200);

    const { outboxEvent } = repository.updateCalls[0];
    expect(outboxEvent.topic).toBe('emergencias.estado-actualizado');
    const event = outboxEvent.payload(
      {
        emergency: { id: EMERGENCY_ID, correlationId: EMERGENCY_ID },
        history: { previousStatus: 'DISPATCHED', newStatus: 'EN_ROUTE' },
      },
      'evt-1'
    );
    expect(event).toMatchObject({
      type: 'EmergenciaActualizada',
      eventId: 'evt-1',
      data: { estadoAnterior: 'DESPACHADA', estadoNuevo: 'EN_CAMINO', usuarioId: 'of-001' },
    });
  });

  it.each([
    ['on-scene desde DISPATCHED (salta EN_ROUTE)', 'on-scene', 'DISPATCHED'],
    ['resolve desde DISPATCHED', 'resolve', 'DISPATCHED'],
    ['resolve desde EN_ROUTE (salta ON_SCENE)', 'resolve', 'EN_ROUTE'],
    ['en-route repetido', 'en-route', 'EN_ROUTE'],
    ['en-route desde RESOLVED (hacia atrás)', 'en-route', 'RESOLVED'],
    ['en-route sobre una emergencia ya cerrada', 'en-route', 'CLOSED'],
  ])('responde 409 y no toca nada: %s', async (_name, action, status) => {
    const repository = createMockRepository({ status });

    const response = await request(buildApp(repository))
      .patch(`/api/emergencies/${EMERGENCY_ID}/${action}`)
      .expect(409);

    expect(response.body.error).toBe('ConflictError');
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('otro oficial recibe 404, igual que si la emergencia no existiera', async () => {
    const repository = createMockRepository();

    const response = await request(buildApp(repository, OTHER_OFFICER))
      .patch(`/api/emergencies/${EMERGENCY_ID}/en-route`)
      .expect(404);

    expect(response.body.message).toMatch(/not found/i);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('una emergencia sin oficial asignado responde 404', async () => {
    const repository = createMockRepository({ status: 'VALIDATED', assignedOfficerId: null });

    await request(buildApp(repository)).patch(`/api/emergencies/${EMERGENCY_ID}/en-route`).expect(404);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('un id inexistente responde 404', async () => {
    const repository = createMockRepository();

    await request(buildApp(repository))
      .patch('/api/emergencies/00000000-0000-4000-8000-000000000000/en-route')
      .expect(404);
  });

  it('un id que no es UUID responde 400 sin consultar la base', async () => {
    const repository = createMockRepository();

    await request(buildApp(repository)).patch('/api/emergencies/nope/en-route').expect(400);
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['dispatcher', { sub: 'D1', groups: ['dispatcher'] }],
    ['citizen', { sub: 'U1', groups: ['citizen'] }],
    ['dispatcher con el sub del oficial', { sub: 'of-001', groups: ['dispatcher'] }],
  ])('un %s recibe 403 en las tres acciones', async (_name, user) => {
    const repository = createMockRepository();
    const app = buildApp(repository, user);

    await request(app).patch(`/api/emergencies/${EMERGENCY_ID}/en-route`).expect(403);
    await request(app).patch(`/api/emergencies/${EMERGENCY_ID}/on-scene`).expect(403);
    await request(app).patch(`/api/emergencies/${EMERGENCY_ID}/resolve`).expect(403);
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it('sin identidad autenticada responde 401', async () => {
    const repository = createMockRepository();

    await request(buildApp(repository, null))
      .patch(`/api/emergencies/${EMERGENCY_ID}/en-route`)
      .expect(401);
  });

  it('si el oficial cambió entre la lectura y el UPDATE, el lock lo rechaza con 404', async () => {
    const repository = createMockRepository();
    // Simula la carrera: findById ve al oficial, pero al tomar el lock la
    // emergencia ya fue devuelta y reasignada a otro.
    repository.findById.mockResolvedValueOnce({
      id: EMERGENCY_ID, status: 'DISPATCHED', assignedOfficerId: 'of-001',
    });
    repository.updateStatus.mockImplementationOnce(async () => {
      throw new NotFoundError(`Emergency with ID ${EMERGENCY_ID} not found`);
    });

    await request(buildApp(repository)).patch(`/api/emergencies/${EMERGENCY_ID}/en-route`).expect(404);
  });
});
