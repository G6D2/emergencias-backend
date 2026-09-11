const request = require('supertest');
const { createApp } = require('../app');
const { NotFoundError } = require('../errors/app-errors');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

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
      if (!current) throw new NotFoundError(`Emergency with ID ${id} not found`);
      const updated = { ...current, status: newStatus, updatedAt: new Date().toISOString() };
      emergencies.set(id, updated);
      return {
        emergency: updated,
        history: { previousStatus: current.status, newStatus, actor, reason },
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
const CITIZEN_B = { sub: 'CIT-002', groups: ['citizen'] };
const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

async function createEmergency(app) {
  const res = await request(app)
    .post('/api/panic-button')
    .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
    .expect(201);
  return res.body.emergencyId;
}

// ---------------------------------------------------------------------------
// GET /api/emergencies
// ---------------------------------------------------------------------------

describe('GET /api/emergencies', () => {
  it('returns only own emergencies for a citizen', async () => {
    const repo = createMockEmergencyRepository();
    const appA = createTestApp(CITIZEN_A, repo);
    const appB = createTestApp(CITIZEN_B, repo);

    await createEmergency(appA);
    await createEmergency(appB);

    const res = await request(appA).get('/api/emergencies').expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].userId).toBe(CITIZEN_A.sub);
  });

  it('returns all emergencies for a dispatcher', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    await createEmergency(citizenApp);
    await createEmergency(citizenApp);

    const res = await request(dispatcherApp).get('/api/emergencies').expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 20 });
  });

  it('returns 400 for an invalid emergencyType filter', async () => {
    const app = createTestApp(DISPATCHER);

    const res = await request(app)
      .get('/api/emergencies?emergencyType=INVALIDO')
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
  });

  it('accepts valid emergencyType aliases from the frontend', async () => {
    const app = createTestApp(DISPATCHER);

    const res = await request(app)
      .get('/api/emergencies?emergencyType=medical')
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 403 when a citizen accesses the dispatcher-only listing (old behavior, now 200 filtered)', async () => {
    // POST /api/emergencies ahora permite citizen pero filtra por userId.
    // Este test documenta que el endpoint NO devuelve 403 para citizen.
    const app = createTestApp(CITIZEN_A);
    const res = await request(app).get('/api/emergencies').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/emergencies/:id
// ---------------------------------------------------------------------------

describe('GET /api/emergencies/:id', () => {
  it('returns full emergency detail with empty statusHistory for a dispatcher', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createEmergency(citizenApp);
    const res = await request(dispatcherApp).get(`/api/emergencies/${id}`).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(id);
    expect(Array.isArray(res.body.data.statusHistory)).toBe(true);
    expect(res.body.data.observations).toEqual([]);
    expect(res.body.data.reinforcementRequests).toEqual([]);
  });

  it('returns own emergency detail for a citizen', async () => {
    const repo = createMockEmergencyRepository();
    const app = createTestApp(CITIZEN_A, repo);

    const id = await createEmergency(app);
    const res = await request(app).get(`/api/emergencies/${id}`).expect(200);

    expect(res.body.data.userId).toBe(CITIZEN_A.sub);
  });

  it('returns 404 when a citizen tries to view another users emergency', async () => {
    const repo = createMockEmergencyRepository();
    const ownerApp = createTestApp(CITIZEN_A, repo);
    const otherApp = createTestApp(CITIZEN_B, repo);

    const id = await createEmergency(ownerApp);
    const res = await request(otherApp).get(`/api/emergencies/${id}`).expect(404);

    expect(res.body.error).toBe('NotFoundError');
  });

  it('returns 404 for a non-existent emergency', async () => {
    const app = createTestApp(DISPATCHER);
    await request(app).get(`/api/emergencies/${FAKE_UUID}`).expect(404);
  });

  it('returns 400 when the id is not a valid UUID', async () => {
    const app = createTestApp(DISPATCHER);
    const res = await request(app).get('/api/emergencies/not-a-uuid').expect(400);

    expect(res.body.error).toBe('ValidationError');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/emergencies/:id/validate
// ---------------------------------------------------------------------------

describe('PATCH /api/emergencies/:id/validate', () => {
  it('transitions a PENDING emergency to VALIDATED', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createEmergency(citizenApp);
    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/validate`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('VALIDATED');
  });

  it('returns 409 when the emergency is already VALIDATED', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createEmergency(citizenApp);
    await request(dispatcherApp).patch(`/api/emergencies/${id}/validate`).expect(200);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/validate`)
      .expect(409);

    expect(res.body.error).toBe('ConflictError');
  });

  it('returns 409 when the emergency is in a terminal status', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createEmergency(citizenApp);
    await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason: 'Falsa alarma' })
      .expect(200);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/validate`)
      .expect(409);

    expect(res.body.error).toBe('ConflictError');
  });

  it('returns 403 when a citizen tries to validate', async () => {
    const repo = createMockEmergencyRepository();
    const app = createTestApp(CITIZEN_A, repo);

    const id = await createEmergency(app);
    const res = await request(app)
      .patch(`/api/emergencies/${id}/validate`)
      .expect(403);

    expect(res.body.error).toBe('ForbiddenError');
  });

  it('returns 404 for a non-existent emergency', async () => {
    const app = createTestApp(DISPATCHER);
    await request(app).patch(`/api/emergencies/${FAKE_UUID}/validate`).expect(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/emergencies/:id/discard
// ---------------------------------------------------------------------------

describe('PATCH /api/emergencies/:id/discard', () => {
  it('transitions a PENDING emergency to DISCARDED with a reason', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createEmergency(citizenApp);
    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason: 'Falsa alarma verificada en campo' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('DISCARDED');
  });

  it('returns 400 when the discard reason is missing', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createEmergency(citizenApp);
    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/discard`)
      .send({})
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
  });

  it('returns 400 when the discard reason is blank whitespace', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createEmergency(citizenApp);
    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason: '   ' })
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
  });

  it('returns 409 when trying to discard a VALIDATED emergency', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createEmergency(citizenApp);
    await request(dispatcherApp).patch(`/api/emergencies/${id}/validate`).expect(200);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason: 'Falsa alarma' })
      .expect(409);

    expect(res.body.error).toBe('ConflictError');
  });

  it('returns 403 when a citizen tries to discard', async () => {
    const repo = createMockEmergencyRepository();
    const app = createTestApp(CITIZEN_A, repo);

    const id = await createEmergency(app);
    const res = await request(app)
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason: 'intento de descarte no autorizado' })
      .expect(403);

    expect(res.body.error).toBe('ForbiddenError');
  });

  it('returns 404 for a non-existent emergency', async () => {
    const app = createTestApp(DISPATCHER);
    await request(app)
      .patch(`/api/emergencies/${FAKE_UUID}/discard`)
      .send({ reason: 'test' })
      .expect(404);
  });
});
