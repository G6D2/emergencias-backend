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
    findPage: async ({ userId, assignedOfficerId } = {}) => {
      const filtered = [...emergencies.values()]
        .filter((e) => !userId || e.userId === userId)
        .filter((e) => !assignedOfficerId || e.assignedOfficerId === assignedOfficerId);
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
const OFFICER_1 = { sub: 'of-001', groups: ['officer'] };
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

  it('a citizen gets 200 (not 403) and ?userId= cannot widen the listing to someone else', async () => {
    // GET /api/emergencies admite citizen, pero el filtro sale del sub del
    // JWT: un userId en el query string se ignora.
    const repo = createMockEmergencyRepository();
    const appA = createTestApp(CITIZEN_A, repo);
    await createEmergency(appA);
    await createEmergency(createTestApp(CITIZEN_B, repo));

    const res = await request(appA)
      .get(`/api/emergencies?userId=${CITIZEN_B.sub}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].userId).toBe(CITIZEN_A.sub);
  });

  it('an officer only gets the emergencies assigned to them, and ?assignedOfficerId= cannot widen it', async () => {
    const repo = createMockEmergencyRepository();
    const citizenApp = createTestApp(CITIZEN_A, repo);
    const mine = await createEmergency(citizenApp);
    const other = await createEmergency(citizenApp);
    await createEmergency(citizenApp);
    repo.create({ ...(await repo.findById(mine)), assignedOfficerId: OFFICER_1.sub });
    repo.create({ ...(await repo.findById(other)), assignedOfficerId: 'of-002' });

    const res = await request(createTestApp(OFFICER_1, repo))
      .get('/api/emergencies?assignedOfficerId=of-002')
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(mine);
    expect(res.body.data[0]).not.toHaveProperty('effectivePriority');
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

  // Hallazgo de auditoría A1: sin validar el formato, un id mal formado
  // llegaba a Postgres y volvía un 500 con el mensaje crudo del driver.
  it('returns 400 (not 500) when the id is not a valid UUID', async () => {
    const app = createTestApp(DISPATCHER);
    const res = await request(app).patch('/api/emergencies/not-a-uuid/validate').expect(400);

    expect(res.body.error).toBe('ValidationError');
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

  // Hallazgo de auditoría A1: sin validar el formato, un id mal formado
  // llegaba a Postgres y volvía un 500 con el mensaje crudo del driver.
  it('returns 400 (not 500) when the id is not a valid UUID', async () => {
    const app = createTestApp(DISPATCHER);
    const res = await request(app)
      .patch('/api/emergencies/not-a-uuid/discard')
      .send({ reason: 'test' })
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
  });
});

// ---------------------------------------------------------------------------
// Sweep técnico: filtros del listado, detalle del citizen, auditoría de
// lecturas y saneo del motivo.
// ---------------------------------------------------------------------------

const DETAIL_UUID = '11111111-1111-4111-8111-111111111111';
const PII_REASON = `Falsa alarma, avisó vecino@example.com al 11 4567-8901. ${'x'.repeat(400)}`;

function createRepositoryWithDetail(overrides = {}) {
  const detail = {
    id: DETAIL_UUID,
    userId: CITIZEN_A.sub,
    status: 'PENDING',
    severity: 'low',
    incident: { id: 'inc-1', priority: 'critical', reportCount: 3 },
    effectivePriority: 'critical',
  };
  return {
    ...createMockEmergencyRepository(),
    findDetailById: async (id) => (id === DETAIL_UUID ? { ...detail, statusHistory: [] } : null),
    recordAccess: jest.fn(async () => ({ id: 1 })),
    ...overrides,
  };
}

describe('GET /api/emergencies — validación de filtros', () => {
  function createSpyApp() {
    const repo = {
      ...createMockEmergencyRepository(),
      findPage: jest.fn(async () => ({ emergencies: [], total: 0 })),
    };
    return { repo, app: createTestApp(DISPATCHER, repo) };
  }

  it.each([
    ['status desconocido', 'status=FOO'],
    ['un status desconocido dentro de la lista', 'status=PENDING,FOO'],
    ['status en minúscula', 'status=pending'],
    ['from que no es fecha', 'from=abc'],
    ['to que no es fecha', 'to=abc'],
    ['from que Date.parse acepta pero no es ISO', 'from=1'],
    ['un día que no existe (Postgres lo rechazaría con 500)', 'to=2026-02-30'],
    ['una hora que no existe', 'from=2026-11-05T25:00:00Z'],
  ])('responde 400 con %s y no consulta la base', async (_label, queryString) => {
    const { repo, app } = createSpyApp();

    const res = await request(app).get(`/api/emergencies?${queryString}`).expect(400);

    expect(res.body.error).toBe('ValidationError');
    expect(repo.findPage).not.toHaveBeenCalled();
  });

  it('acepta una lista de estados conocidos y fechas ISO, y se las pasa al repository', async () => {
    const { repo, app } = createSpyApp();

    await request(app)
      .get('/api/emergencies')
      .query({
        status: 'CLOSED,CANCELLED,DISCARDED,RESOLVED',
        from: '2026-11-01',
        to: '2026-11-05T23:59:59.999-03:00',
      })
      .expect(200);

    expect(repo.findPage).toHaveBeenCalledWith(expect.objectContaining({
      statuses: ['CLOSED', 'CANCELLED', 'DISCARDED', 'RESOLVED'],
      from: '2026-11-01',
      to: '2026-11-05T23:59:59.999-03:00',
    }));
  });

  it('sin from/to no manda fechas al repository', async () => {
    const { repo, app } = createSpyApp();

    await request(app).get('/api/emergencies?from=').expect(200);

    expect(repo.findPage).toHaveBeenCalledWith(expect.objectContaining({ from: undefined, to: undefined }));
  });
});

describe('GET /api/emergencies/:id — recorte para citizen y auditoría', () => {
  it('un citizen no recibe incident ni effectivePriority en el detalle de su emergencia', async () => {
    const app = createTestApp(CITIZEN_A, createRepositoryWithDetail());

    const res = await request(app).get(`/api/emergencies/${DETAIL_UUID}`).expect(200);

    expect(res.body.data.id).toBe(DETAIL_UUID);
    expect(res.body.data).not.toHaveProperty('incident');
    expect(res.body.data).not.toHaveProperty('effectivePriority');
    expect(res.body.data.severity).toBe('low');
  });

  it('un dispatcher sí recibe incident y effectivePriority', async () => {
    const app = createTestApp(DISPATCHER, createRepositoryWithDetail());

    const res = await request(app).get(`/api/emergencies/${DETAIL_UUID}`).expect(200);

    expect(res.body.data.incident).toMatchObject({ id: 'inc-1', priority: 'critical' });
    expect(res.body.data.effectivePriority).toBe('critical');
  });

  it('registra la lectura con el sub del lector, igual que el endpoint viejo', async () => {
    const repo = createRepositoryWithDetail();
    const app = createTestApp(DISPATCHER, repo);

    await request(app).get(`/api/emergencies/${DETAIL_UUID}`).expect(200);

    expect(repo.recordAccess).toHaveBeenCalledTimes(1);
    expect(repo.recordAccess).toHaveBeenCalledWith({
      emergencyId: DETAIL_UUID,
      actorSub: DISPATCHER.sub,
      action: 'emergency:read',
    });
  });

  it('no registra lecturas rechazadas (emergencia ajena o inexistente)', async () => {
    const repo = createRepositoryWithDetail();

    await request(createTestApp(CITIZEN_B, repo)).get(`/api/emergencies/${DETAIL_UUID}`).expect(404);
    await request(createTestApp(DISPATCHER, repo)).get(`/api/emergencies/${FAKE_UUID}`).expect(404);

    expect(repo.recordAccess).not.toHaveBeenCalled();
  });

  it('si la auditoría falla, la lectura ya autorizada responde igual', async () => {
    const repo = createRepositoryWithDetail({
      recordAccess: jest.fn(async () => { throw new Error('audit down'); }),
    });
    const app = createTestApp(DISPATCHER, repo);

    const res = await request(app).get(`/api/emergencies/${DETAIL_UUID}`).expect(200);

    expect(res.body.data.id).toBe(DETAIL_UUID);
    expect(repo.recordAccess).toHaveBeenCalledTimes(1);
  });

  it('el listado no audita por emergencia', async () => {
    const repo = createRepositoryWithDetail();
    const app = createTestApp(DISPATCHER, repo);

    await request(app).get('/api/emergencies').expect(200);

    expect(repo.recordAccess).not.toHaveBeenCalled();
  });
});

describe('Motivo de descarte y cancelación', () => {
  it.each([
    ['un objeto', { text: 'Falsa alarma' }],
    ['un número', 42],
    ['una lista', ['Falsa alarma']],
  ])('discard responde 400 si reason es %s', async (_label, reason) => {
    const repo = createMockEmergencyRepository();
    const updateStatus = jest.spyOn(repo, 'updateStatus');
    const id = await createEmergency(createTestApp(CITIZEN_A, repo));

    const res = await request(createTestApp(DISPATCHER, repo))
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason })
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('discard guarda el motivo con la PII redactada y recortado a 280 caracteres', async () => {
    const repo = createMockEmergencyRepository();
    const updateStatus = jest.spyOn(repo, 'updateStatus');
    const id = await createEmergency(createTestApp(CITIZEN_A, repo));

    await request(createTestApp(DISPATCHER, repo))
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason: PII_REASON })
      .expect(200);

    const { reason } = updateStatus.mock.calls[0][1];
    expect(reason).toMatch(/^Falsa alarma, avisó \[email\] al \[tel\]\./);
    expect(reason).not.toContain('vecino@example.com');
    expect(reason).not.toContain('4567-8901');
    expect(reason.length).toBeLessThanOrEqual(280);
  });

  it('el motivo saneado es el que viaja en el evento del outbox (resolucion)', async () => {
    const repo = createMockEmergencyRepository();
    const updateStatus = jest.spyOn(repo, 'updateStatus');
    const id = await createEmergency(createTestApp(CITIZEN_A, repo));

    await request(createTestApp(DISPATCHER, repo))
      .patch(`/api/emergencies/${id}/discard`)
      .send({ reason: 'Duplicado, llamó vecino@example.com' })
      .expect(200);

    const { outboxEvent } = updateStatus.mock.calls[0][1];
    const event = outboxEvent.payload({
      emergency: { id, status: 'DISCARDED' },
      history: { previousStatus: 'PENDING', newStatus: 'DISCARDED' },
    }, 'event-1');
    expect(event.data.resolucion).toBe('Duplicado, llamó [email]');
  });

  it('cancel responde 400 si reason no es string', async () => {
    const repo = createMockEmergencyRepository();
    const updateStatus = jest.spyOn(repo, 'updateStatus');
    const app = createTestApp(CITIZEN_A, repo);
    const id = await createEmergency(app);

    const res = await request(app)
      .patch(`/api/emergencies/${id}/cancel`)
      .send({ reason: { motivo: 'Ya no necesito asistencia' } })
      .expect(400);

    expect(res.body.error).toBe('ValidationError');
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('cancel sanea el motivo y uno vacío queda null', async () => {
    const repo = createMockEmergencyRepository();
    const updateStatus = jest.spyOn(repo, 'updateStatus');
    const app = createTestApp(CITIZEN_A, repo);
    const first = await createEmergency(app);
    const second = await createEmergency(app);

    await request(app).patch(`/api/emergencies/${first}/cancel`).send({ reason: PII_REASON }).expect(200);
    await request(app).patch(`/api/emergencies/${second}/cancel`).send({ reason: '   ' }).expect(200);

    const [scrubbed, blank] = updateStatus.mock.calls.map(([, options]) => options.reason);
    expect(scrubbed).not.toContain('vecino@example.com');
    expect(scrubbed.length).toBeLessThanOrEqual(280);
    expect(blank).toBeNull();
  });
});
