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

// Repo en memoria que además modela la liberación del oficial al pasar a
// VALIDATED, para verificar el efecto de la devolución de punta a punta. La
// liberación real (transacción SQL) ya está cubierta en
// emergency.repository(.integration).test.js.
function createMockEmergencyRepository() {
  const emergencies = new Map();
  const officers = new Map();

  return {
    officers,
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
      // Espeja el comportamiento del repo real: al devolver a VALIDATED (o
      // cancelar/cerrar) el oficial asignado vuelve a disponible.
      if (current.assignedOfficerId
        && ['VALIDATED', 'CANCELLED', 'CLOSED'].includes(newStatus)) {
        officers.set(current.assignedOfficerId, 'disponible');
        updated.assignedOfficerId = newStatus === 'VALIDATED' ? null : current.assignedOfficerId;
      }
      emergencies.set(id, updated);
      return {
        emergency: updated,
        history: { previousStatus: current.status, newStatus, actor, reason },
      };
    },
    assignOfficer: async (id, { officerId }) => {
      const current = emergencies.get(id);
      if (!current) throw new NotFoundError(`No se encontró la emergencia ${id}`);
      officers.set(officerId, 'ocupado');
      const updated = {
        ...current,
        status: 'DISPATCHED',
        assignedOfficerId: officerId,
        updatedAt: new Date().toISOString(),
      };
      emergencies.set(id, updated);
      return { emergency: updated, officer: { id: officerId, name: 'Juan Oficial' } };
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

async function createValidateAndAssign(repo) {
  const citizenApp = createTestApp(CITIZEN_A, repo);
  const dispatcherApp = createTestApp(DISPATCHER, repo);

  const createRes = await request(citizenApp)
    .post('/api/panic-button')
    .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
    .expect(201);
  const id = createRes.body.emergencyId;

  await request(dispatcherApp).patch(`/api/emergencies/${id}/validate`).expect(200);
  await request(dispatcherApp)
    .patch(`/api/emergencies/${id}/assign`)
    .send({ officerId: FAKE_OFFICER_ID })
    .expect(200);

  return id;
}

// ---------------------------------------------------------------------------
// PATCH /api/emergencies/:id/return
// ---------------------------------------------------------------------------

describe('PATCH /api/emergencies/:id/return', () => {
  it('devuelve una emergencia DISPATCHED a VALIDATED y libera al oficial', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createValidateAndAssign(repo);
    expect(repo.officers.get(FAKE_OFFICER_ID)).toBe('ocupado');

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/return`)
      .send({ reason: 'Despacho equivocado' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('VALIDATED');
    expect(repo.officers.get(FAKE_OFFICER_ID)).toBe('disponible');
  });

  it('permite reasignar tras la devolución', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createValidateAndAssign(repo);
    await request(dispatcherApp).patch(`/api/emergencies/${id}/return`).send({}).expect(200);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: FAKE_OFFICER_ID })
      .expect(200);
    expect(res.body.data.status).toBe('DISPATCHED');
  });

  it('funciona sin body (reason opcional)', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const id = await createValidateAndAssign(repo);
    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/return`)
      .expect(200);
    expect(res.body.data.status).toBe('VALIDATED');
  });

  it('responde 409 si la emergencia no está DISPATCHED (ej. VALIDATED)', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const dispatcherApp = createTestApp(DISPATCHER, repo);

    const createRes = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);
    const id = createRes.body.emergencyId;
    await request(dispatcherApp).patch(`/api/emergencies/${id}/validate`).expect(200);

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/return`)
      .send({})
      .expect(409);
    expect(res.body.error).toBe('ConflictError');
  });

  it('responde 400 si el id no es un UUID válido', async () => {
    const app = createTestApp(DISPATCHER);
    const res = await request(app)
      .patch('/api/emergencies/not-a-uuid/return')
      .send({})
      .expect(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('responde 404 si la emergencia no existe', async () => {
    const app = createTestApp(DISPATCHER);
    await request(app)
      .patch(`/api/emergencies/${FAKE_UUID}/return`)
      .send({})
      .expect(404);
  });

  it('responde 403 si un citizen intenta devolver', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const id = await createValidateAndAssign(repo);

    const res = await request(citizenApp)
      .patch(`/api/emergencies/${id}/return`)
      .send({})
      .expect(403);
    expect(res.body.error).toBe('ForbiddenError');
  });
});

// ---------------------------------------------------------------------------
// /validate y /return dejan de ser intercambiables: los dos llegan a
// VALIDATED, pero validar solo sale de PENDING y devolver solo de DISPATCHED.
// ---------------------------------------------------------------------------

describe('PATCH /api/emergencies/:id/validate vs /return', () => {
  it('validate sobre una DISPATCHED responde 409 y no libera al oficial', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);
    const id = await createValidateAndAssign(repo);
    const updateStatus = jest.spyOn(repo, 'updateStatus');

    const res = await request(dispatcherApp)
      .patch(`/api/emergencies/${id}/validate`)
      .expect(409);

    expect(res.body).toEqual({
      error: 'ConflictError',
      message: `La emergencia ${id} está en DISPATCHED, se esperaba PENDING`,
    });
    expect(updateStatus).not.toHaveBeenCalled();
    expect(repo.officers.get(FAKE_OFFICER_ID)).toBe('ocupado');
    expect((await repo.findById(id)).assignedOfficerId).toBe(FAKE_OFFICER_ID);
  });

  it('return sobre una PENDING responde 409', async () => {
    const repo = createMockEmergencyRepository();
    const createRes = await request(createTestApp(CITIZEN_A, repo))
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    const res = await request(createTestApp(DISPATCHER, repo))
      .patch(`/api/emergencies/${createRes.body.emergencyId}/return`)
      .send({})
      .expect(409);

    expect(res.body.message).toBe(`La emergencia ${createRes.body.emergencyId} está en PENDING, se esperaba DISPATCHED`);
  });

  it('cada endpoint le pide al repository que revalide su estado de origen con la fila bloqueada', async () => {
    const repo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp(DISPATCHER, repo);
    const updateStatus = jest.spyOn(repo, 'updateStatus');

    const id = await createValidateAndAssign(repo);
    await request(dispatcherApp).patch(`/api/emergencies/${id}/return`).send({}).expect(200);

    expect(updateStatus.mock.calls.map(([, options]) => [options.newStatus, options.requireStatus])).toEqual([
      ['VALIDATED', 'PENDING'],
      ['VALIDATED', 'DISPATCHED'],
    ]);
  });

  it('return responde 400 si reason no es string', async () => {
    const repo = createMockEmergencyRepository();
    const id = await createValidateAndAssign(repo);

    const res = await request(createTestApp(DISPATCHER, repo))
      .patch(`/api/emergencies/${id}/return`)
      .send({ reason: 123 })
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
    expect(repo.officers.get(FAKE_OFFICER_ID)).toBe('ocupado');
  });

  it('return guarda el motivo con la PII redactada', async () => {
    const repo = createMockEmergencyRepository();
    const id = await createValidateAndAssign(repo);
    const updateStatus = jest.spyOn(repo, 'updateStatus');

    await request(createTestApp(DISPATCHER, repo))
      .patch(`/api/emergencies/${id}/return`)
      .send({ reason: 'El oficial avisó por el 11 4567-8901 que no llega' })
      .expect(200);

    expect(updateStatus.mock.calls[0][1].reason).toBe('El oficial avisó por el [tel] que no llega');
  });
});
