const request = require('supertest');
const { createApp } = require('../app');
const { NotFoundError } = require('../errors/app-errors');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

const FAKE_OFFICER_ID = 'officer-001';
const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

function createMockEmergencyRepository() {
  const emergencies = new Map();

  return {
    create: async (emergency) => {
      const saved = { ...emergency, locationAnonymized: false };
      emergencies.set(saved.id, saved);
      return saved;
    },
    findById: async (id) => emergencies.get(id) || null,
    findDetailById: async (id) => {
      const emergency = emergencies.get(id);
      if (!emergency) return null;
      return { ...emergency, statusHistory: [] };
    },
    recordAccess: async () => ({ id: 1 }),
    updateStatus: async (id, { newStatus, actor = null, reason = null }) => {
      const current = emergencies.get(id);
      if (!current) throw new NotFoundError(`No se encontró la emergencia ${id}`);
      const updated = { ...current, status: newStatus, updatedAt: new Date().toISOString() };
      emergencies.set(id, updated);
      return {
        emergency: updated,
        history: { previousStatus: current.status, newStatus, actor, reason },
      };
    },
    assignOfficer: async (id, { officerId }) => {
      const current = emergencies.get(id);
      if (!current) throw new NotFoundError(`No se encontró la emergencia ${id}`);
      const updated = {
        ...current,
        status: 'DISPATCHED',
        assignedOfficerId: officerId,
        updatedAt: new Date().toISOString(),
      };
      emergencies.set(id, updated);
      return {
        emergency: updated,
        officer: { id: officerId, name: 'Juan Oficial' },
      };
    },
    findPage: async ({ userId } = {}) => {
      const all = [...emergencies.values()];
      const filtered = userId ? all.filter((e) => e.userId === userId) : all;
      return { emergencies: filtered, total: filtered.length };
    },
  };
}

function stubAuthenticate(user) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

function createTestApp(user, repository = createMockEmergencyRepository()) {
  return createApp(mockKafkaService, repository, {
    authenticate: stubAuthenticate(user),
  });
}

const DISPATCHER = { sub: 'DISP-001', groups: ['dispatcher'] };
const CITIZEN_A = { sub: 'CIT-001', groups: ['citizen'] };

async function createAndValidateEmergency(repo) {
  const citizenApp = createTestApp(CITIZEN_A, repo);
  const dispatcherApp = createTestApp(DISPATCHER, repo);

  const createRes = await request(citizenApp)
    .post('/api/panic-button')
    .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
    .expect(201);

  const id = createRes.body.emergencyId;

  await request(dispatcherApp).patch(`/api/emergencies/${id}/validate`).expect(200);

  return id;
}

// ---------------------------------------------------------------------------
// PATCH /api/emergencies/:id/assign
// ---------------------------------------------------------------------------

describe('PATCH /api/emergencies/:id/assign', () => {
  it('transitions a VALIDATED emergency to DISPATCHED', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createAndValidateEmergency(repo);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('DISPATCHED');
    expect(res.body.data.assignedOfficerId).toBe(FAKE_OFFICER_ID);
  });

  it('includes the officer name in the response', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createAndValidateEmergency(repo);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(200);

    expect(res.body.data.assignedOfficer).toBe('Juan Oficial');
  });

  it('returns 400 when officerId is missing', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createAndValidateEmergency(repo);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/assign`)
      .send({})
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
  });

  it('returns 400 when officerId is blank whitespace', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createAndValidateEmergency(repo);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: '   ' })
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
  });

  it('returns 400 when the emergency id is not a valid UUID', async () => {
    const app = createTestApp(DISPATCHER);

    const res = await request(app)
      .patch('/api/emergencies/not-a-uuid/assign')
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
  });

  it('returns 404 when the emergency does not exist', async () => {
    const app = createTestApp(DISPATCHER);

    await request(app)
      .patch(`/api/emergencies/${FAKE_UUID}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(404);
  });

  it('returns 409 when the emergency is in PENDING status (cannot skip VALIDATED)', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const createRes = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${createRes.body.emergencyId}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(409);

    expect(res.body.error).toBe('ConflictError');
  });

  it('returns 409 when the emergency is already DISPATCHED', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createAndValidateEmergency(repo);

    await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(200);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(409);

    expect(res.body.error).toBe('ConflictError');
  });

  it('returns 409 when the emergency is in a terminal status', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const createRes = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    const id = createRes.body.emergencyId;
    await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason: 'Falsa alarma' })
      .expect(200);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(409);

    expect(res.body.error).toBe('ConflictError');
  });

  it('returns 403 when a citizen tries to assign', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);

    const createRes = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    const res = await request(citizenApp)
      .patch(`/api/emergencies/${createRes.body.emergencyId}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(403);

    expect(res.body.error).toBe('ForbiddenError');
  });
});
