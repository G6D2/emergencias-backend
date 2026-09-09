const request = require('supertest');
const { createApp } = require('../app');
const { createAuthenticateMiddleware } = require('../auth/authenticate');
const { KafkaService } = require('../services/kafka.service');
const { NotFoundError } = require('../errors/app-errors');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

function createMockEmergencyRepository() {
  const emergencies = new Map();
  const accessAudit = [];
  const updateStatusCalls = [];
  const findPageCalls = [];

  return {
    updateStatusCalls,
    findPageCalls,
    // Refleja lo que devuelve mapEmergency: sin el outboxEvent y con
    // emergencyType/correlationId tal como los recibe del controller.
    create: async ({ outboxEvent, ...emergency }) => {
      void outboxEvent;
      const saved = {
        ...emergency,
        correlationId: emergency.correlationId || emergency.id,
        emergencyType: emergency.emergencyType || null,
        locationAnonymized: false,
      };
      emergencies.set(saved.id, saved);
      return saved;
    },
    findById: async (id) => emergencies.get(id) || null,
    recordAccess: async ({ emergencyId, actorSub, action }) => {
      const entry = {
        id: accessAudit.length + 1,
        emergencyId,
        actorSub,
        action,
        createdAt: new Date().toISOString(),
      };
      accessAudit.push(entry);
      return entry;
    },
    updateStatus: async (id, { newStatus, actor = null, reason = null, outboxEvent = null }) => {
      updateStatusCalls.push({ id, newStatus, actor, reason, outboxEvent });
      const current = emergencies.get(id);
      if (!current) {
        throw new NotFoundError(`Emergency with ID ${id} not found`);
      }
      const previousStatus = current.status;
      const updated = { ...current, status: newStatus, updatedAt: new Date().toISOString() };
      emergencies.set(id, updated);
      return {
        emergency: updated,
        history: {
          previousStatus,
          newStatus,
          actor,
          reason,
        },
      };
    },
    findPage: async (filters) => {
      findPageCalls.push(filters);
      const matching = [...emergencies.values()]
        .filter((emergency) => !filters.emergencyType || emergency.emergencyType === filters.emergencyType);
      return { emergencies: matching, total: matching.length };
    },
    findOutboxPage: async ({ page, limit }) => ({
      events: [{
        id: 'outbox-event-1',
        topic: 'emergencias.boton-panico',
        status: 'PENDING',
        attempts: 0,
        createdAt: new Date().toISOString(),
      }],
      total: 1,
      page,
      limit,
    }),
  };
}

/** Stub auth: fija req.user sin validar JWT (los tests de firma viven en auth.test.js). */
function stubAuthenticate(user = {
  sub: 'U000042',
  groups: ['citizen'],
  username: 'jperez',
}) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

function createTestApp(authenticateUser, repository = createMockEmergencyRepository()) {
  return createApp(mockKafkaService, repository, {
    authenticate: stubAuthenticate(authenticateUser),
  });
}

const app = createTestApp();

describe('Panic Button API', () => {
  it('accepts the emergency when Kafka is unavailable if the repository owns the outbox transaction', async () => {
    const savedEmergency = {
      id: 'outbox-emergency-1',
      userId: 'U000042',
      status: 'PENDING',
      locationAnonymized: false,
    };
    const outboxEvents = [];
    const outboxRepository = {
      insertOutboxEvent: () => {},
      create: async ({ outboxEvent }) => {
        outboxEvents.push(outboxEvent);
        return savedEmergency;
      },
      findById: async () => savedEmergency,
      findPage: async () => ({ emergencies: [savedEmergency], total: 1 }),
    };
    const unavailableKafka = {
      publishEvent: async () => {
        throw new Error('Kafka unavailable');
      },
      isConnected: () => false,
      isEnabled: () => true,
      checkHealth: async () => false,
    };
    const outboxApp = createApp(unavailableKafka, outboxRepository, {
      authenticate: stubAuthenticate(),
    });

    const response = await request(outboxApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    expect(response.body.success).toBe(true);
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0].topic).toBe('emergencias.boton-panico');
    const event = outboxEvents[0].payload(savedEmergency, 'event-1');
    expect(event).toMatchObject({
      type: 'EmergenciaCreada',
      eventId: 'event-1',
      correlationId: savedEmergency.id,
    });
    expect(event.data.latitude).toBeUndefined();
    expect(event.data.longitude).toBeUndefined();
  });

  describe('POST /api/panic-button', () => {
    it('should trigger panic button successfully using JWT sub as userId', async () => {
      const payload = {
        location: {
          latitude: -34.6037,
          longitude: -58.3816,
        },
        description: 'Test panic button',
      };

      const response = await request(app)
        .post('/api/panic-button')
        .send(payload)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.emergencyId).toBeDefined();
      expect(response.body.data.userId).toBe('U000042');
      expect(response.body.data.status).toBe('PENDING');
    });

    it('persiste el emergencyType normalizado al catálogo (alias del front fire → INCENDIO)', async () => {
      const response = await request(app)
        .post('/api/panic-button')
        .send({
          location: { latitude: -34.6037, longitude: -58.3816 },
          emergencyType: 'fire',
        })
        .expect(201);

      expect(response.body.data.emergencyType).toBe('INCENDIO');
    });

    it('acepta el canónico en cualquier casing', async () => {
      const response = await request(app)
        .post('/api/panic-button')
        .send({
          location: { latitude: -34.6037, longitude: -58.3816 },
          emergencyType: ' medica ',
        })
        .expect(201);

      expect(response.body.data.emergencyType).toBe('MEDICA');
    });

    it('sin emergencyType asume PANICO (es el endpoint del botón SOS)', async () => {
      const response = await request(app)
        .post('/api/panic-button')
        .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
        .expect(201);

      expect(response.body.data.emergencyType).toBe('PANICO');
    });

    it('rechaza con 400 un emergencyType fuera del catálogo y no crea nada', async () => {
      const repo = createMockEmergencyRepository();
      const isolatedApp = createTestApp(undefined, repo);

      const response = await request(isolatedApp)
        .post('/api/panic-button')
        .send({
          location: { latitude: -34.6037, longitude: -58.3816 },
          emergencyType: 'flood',
        })
        .expect(400);

      expect(response.body.error).toBe('ValidationError');
      expect(response.body.message).toContain('MEDICA, INCENDIO, INFRAESTRUCTURA, DISTURBIO_EVENTO_MASIVO, OTRO, PANICO');
      const { total } = await repo.findPage({});
      expect(total).toBe(0);
    });

    it('devuelve correlationId igual al id de la emergencia', async () => {
      const response = await request(app)
        .post('/api/panic-button')
        .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
        .expect(201);

      expect(response.body.data.correlationId).toBe(response.body.emergencyId);
      expect(response.body.data.correlationId).toBe(response.body.data.id);
    });

    it('el evento EmergenciaCreada lleva el tipo canónico y correlationId = id en data', async () => {
      const outboxEvents = [];
      const repo = createMockEmergencyRepository();
      const originalCreate = repo.create;
      repo.create = async (emergency) => {
        outboxEvents.push(emergency.outboxEvent);
        return originalCreate(emergency);
      };
      const eventApp = createTestApp(undefined, repo);

      const response = await request(eventApp)
        .post('/api/panic-button')
        .send({
          location: { latitude: -34.6037, longitude: -58.3816 },
          emergencyType: 'disturbance',
        })
        .expect(201);

      const saved = await repo.findById(response.body.emergencyId);
      const event = outboxEvents[0].payload(saved, 'event-1');
      expect(event).toMatchObject({
        type: 'EmergenciaCreada',
        correlationId: saved.id,
        data: {
          id: saved.id,
          correlationId: saved.id,
          emergencyType: 'DISTURBIO_EVENTO_MASIVO',
        },
      });
    });

    it('ignores client-supplied userId and uses token sub', async () => {
      const response = await request(app)
        .post('/api/panic-button')
        .send({
          userId: 'attacker-spoofed-id',
          location: { latitude: -34.6037, longitude: -58.3816 },
        })
        .expect(201);

      expect(response.body.data.userId).toBe('U000042');
    });

    it('should fail without required fields', async () => {
      const payload = {
        description: 'Missing location',
      };

      const response = await request(app)
        .post('/api/panic-button')
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe('ValidationError');
    });

    it('returns 401 when Authorization is missing', async () => {
      const unauthApp = createApp(mockKafkaService, createMockEmergencyRepository(), {
        authenticate: createAuthenticateMiddleware({
          config: {
            issuer: 'https://idp.citypass.local',
            audience: 'citypass-emergencias-api',
            jwksUri: 'https://idp.citypass.local/.well-known/jwks.json',
            clockTolerance: 60,
            expectedTokenUse: 'human',
            expectedVer: 1,
          },
          verifyAccessToken: async () => {
            throw new Error('verify should not run without Bearer token');
          },
        }),
      });

      const response = await request(unauthApp)
        .post('/api/panic-button')
        .send({
          location: { latitude: -34.6037, longitude: -58.3816 },
        })
        .expect(401);

      expect(response.body.error).toBe('UnauthorizedError');
    });

    it('returns 403 when user has no citizen group', async () => {
      const dispatcherApp = createTestApp({
        sub: 'U000099',
        groups: ['dispatcher'],
      });

      const response = await request(dispatcherApp)
        .post('/api/panic-button')
        .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
        .expect(403);

      expect(response.body.error).toBe('ForbiddenError');
    });

    it('returns 403 when groups is empty', async () => {
      const noGroupsApp = createTestApp({
        sub: 'U000042',
        groups: [],
      });

      const response = await request(noGroupsApp)
        .post('/api/panic-button')
        .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
        .expect(403);

      expect(response.body.error).toBe('ForbiddenError');
    });
  });

  describe('GET /api/panic-button/:id', () => {
    it('should retrieve panic button event', async () => {
      const createResponse = await request(app)
        .post('/api/panic-button')
        .send({
          location: { latitude: -34.6037, longitude: -58.3816 },
        });

      const emergencyId = createResponse.body.emergencyId;

      const getResponse = await request(app)
        .get(`/api/panic-button/${emergencyId}`)
        .expect(200);

      expect(getResponse.body.success).toBe(true);
      expect(getResponse.body.data.id).toBe(emergencyId);
    });

    it('should return 404 when emergency does not exist', async () => {
      const response = await request(app)
        .get('/api/panic-button/00000000-0000-0000-0000-000000000000')
        .expect(404);

      expect(response.body.error).toBe('NotFoundError');
    });

    it('returns 403 when citizen tries to view another user emergency', async () => {
      const sharedRepo = createMockEmergencyRepository();
      const ownerApp = createTestApp({
        sub: 'U000042',
        groups: ['citizen'],
      }, sharedRepo);
      const otherApp = createTestApp({
        sub: 'U000099',
        groups: ['citizen'],
      }, sharedRepo);

      const createResponse = await request(ownerApp)
        .post('/api/panic-button')
        .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
        .expect(201);

      const response = await request(otherApp)
        .get(`/api/panic-button/${createResponse.body.emergencyId}`)
        .expect(403);

      expect(response.body.error).toBe('ForbiddenError');
    });

    it('allows dispatcher to view any emergency', async () => {
      const sharedRepo = createMockEmergencyRepository();
      const ownerApp = createTestApp({
        sub: 'U000042',
        groups: ['citizen'],
      }, sharedRepo);
      const dispatcherApp = createTestApp({
        sub: 'U000999',
        groups: ['dispatcher'],
      }, sharedRepo);

      const createResponse = await request(ownerApp)
        .post('/api/panic-button')
        .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
        .expect(201);

      const getResponse = await request(dispatcherApp)
        .get(`/api/panic-button/${createResponse.body.emergencyId}`)
        .expect(200);

      expect(getResponse.body.data.userId).toBe('U000042');
    });
  });
});

describe('Emergencies API', () => {
  it('un citizen lista solo sus propias emergencias (filtro forzado por sub del JWT)', async () => {
    const calls = [];
    const repository = {
      ...createMockEmergencyRepository(),
      findPage: async (filters) => {
        calls.push(filters);
        return { emergencies: [], total: 0 };
      },
    };
    const citizenApp = createApp(mockKafkaService, repository, {
      authenticate: stubAuthenticate({ sub: 'CIT-jperez', groups: ['citizen'] }),
    });

    await request(citizenApp)
      .get('/api/emergencies?limit=100&userId=OTRO')
      .expect(200);

    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe('CIT-jperez');
  });

  it('un dispatcher lista sin filtro de usuario', async () => {
    const calls = [];
    const repository = {
      ...createMockEmergencyRepository(),
      findPage: async (filters) => {
        calls.push(filters);
        return { emergencies: [], total: 0 };
      },
    };
    const dispatcherApp = createApp(mockKafkaService, repository, {
      authenticate: stubAuthenticate({ sub: 'U000999', groups: ['dispatcher'] }),
    });

    await request(dispatcherApp).get('/api/emergencies').expect(200);

    expect(calls[0].userId).toBeUndefined();
  });

  it('un usuario sin grupo citizen ni dispatcher recibe 403 al listar', async () => {
    const otherApp = createTestApp({ sub: 'X1', groups: ['officer'] });
    await request(otherApp).get('/api/emergencies').expect(403);
  });

  it('allows a dispatcher to inspect outbox status without exposing payload', async () => {
    const dispatcherApp = createTestApp({
      sub: 'U000999',
      groups: ['dispatcher'],
    });

    const response = await request(dispatcherApp)
      .get('/api/outbox-events?status=PENDING&limit=10')
      .expect(200);

    expect(response.body).toMatchObject({
      data: [{
        id: 'outbox-event-1',
        status: 'PENDING',
      }],
      pagination: {
        page: 1,
        limit: 10,
        total: 1,
      },
    });
    expect(response.body.data[0].payload).toBeUndefined();
  });

  it('forbids a citizen from inspecting outbox status', async () => {
    await request(app)
      .get('/api/outbox-events')
      .expect(403);
  });

  it('allows a dispatcher to validate a pending emergency and stores a status outbox event', async () => {
    const validationKafka = {
      publishEvent: async () => {},
      isConnected: () => true,
      checkHealth: async () => false,
    };
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createApp(validationKafka, sharedRepo, {
      authenticate: stubAuthenticate({ sub: 'U000042', groups: ['citizen'] }),
    });
    const dispatcherApp = createApp(validationKafka, sharedRepo, {
      authenticate: stubAuthenticate({ sub: 'U000999', groups: ['dispatcher'] }),
    });

    const createResponse = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    const response = await request(dispatcherApp)
      .patch(`/api/emergencies/${createResponse.body.emergencyId}/validate`)
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      data: { status: 'VALIDATED' },
    });
    const statusEvent = sharedRepo.updateStatusCalls.at(-1).outboxEvent;
    expect(statusEvent.topic).toBe('emergencias.estado-actualizado');
    expect(statusEvent.payload({
      emergency: response.body.data,
      history: { previousStatus: 'PENDING', newStatus: 'VALIDATED' },
    }, 'event-1')).toMatchObject({
      type: 'EmergenciaEstadoActualizado',
      eventId: 'event-1',
      correlationId: response.body.data.id,
      data: {
        previousStatus: 'PENDING',
        newStatus: 'VALIDATED',
        actor: 'U000999',
      },
    });
  });

  it('forbids a citizen from validating an emergency', async () => {
    const response = await request(app)
      .patch('/api/emergencies/00000000-0000-0000-0000-000000000000/validate')
      .expect(403);

    expect(response.body.error).toBe('ForbiddenError');
  });

  it('returns 409 when validating an emergency that is not pending', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp({
      sub: 'U000999',
      groups: ['dispatcher'],
    }, sharedRepo);
    const citizenApp = createTestApp({
      sub: 'U000042',
      groups: ['citizen'],
    }, sharedRepo);

    const createResponse = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    await request(dispatcherApp)
      .patch(`/api/emergencies/${createResponse.body.emergencyId}/validate`)
      .expect(200);

    const response = await request(dispatcherApp)
      .patch(`/api/emergencies/${createResponse.body.emergencyId}/validate`)
      .expect(409);

    expect(response.body.error).toBe('ConflictError');
  });

  it('allows a dispatcher to discard a pending emergency with a reason and stores the status outbox event', async () => {
    const discardKafka = {
      publishEvent: async () => {},
      isConnected: () => true,
      checkHealth: async () => false,
    };
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createApp(discardKafka, sharedRepo, {
      authenticate: stubAuthenticate({ sub: 'U000042', groups: ['citizen'] }),
    });
    const dispatcherApp = createApp(discardKafka, sharedRepo, {
      authenticate: stubAuthenticate({ sub: 'U000999', groups: ['dispatcher'] }),
    });

    const createResponse = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    const response = await request(dispatcherApp)
      .patch(`/api/emergencies/${createResponse.body.emergencyId}/discard`)
      .send({ reason: 'Reporte invalido' })
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      data: { status: 'DISCARDED' },
    });
    expect(sharedRepo.updateStatusCalls.at(-1)).toMatchObject({
      newStatus: 'DISCARDED',
      actor: 'U000999',
      reason: 'Reporte invalido',
    });
    const statusEvent = sharedRepo.updateStatusCalls.at(-1).outboxEvent;
    expect(statusEvent.topic).toBe('emergencias.estado-actualizado');
    expect(statusEvent.payload({
      emergency: response.body.data,
      history: { previousStatus: 'PENDING', newStatus: 'DISCARDED' },
    }, 'event-2')).toMatchObject({
      type: 'EmergenciaEstadoActualizado',
      eventId: 'event-2',
      correlationId: response.body.data.id,
      data: {
        previousStatus: 'PENDING',
        newStatus: 'DISCARDED',
        actor: 'U000999',
        reason: 'Reporte invalido',
      },
    });
  });

  it('requires a discard reason and only allows dispatchers to discard', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createTestApp({
      sub: 'U000042',
      groups: ['citizen'],
    }, sharedRepo);
    const dispatcherApp = createTestApp({
      sub: 'U000999',
      groups: ['dispatcher'],
    }, sharedRepo);

    const createResponse = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);
    const emergencyId = createResponse.body.emergencyId;

    await request(citizenApp)
      .patch(`/api/emergencies/${emergencyId}/discard`)
      .send({ reason: 'No corresponde' })
      .expect(403);

    const missingReason = await request(dispatcherApp)
      .patch(`/api/emergencies/${emergencyId}/discard`)
      .send({ reason: '   ' })
      .expect(400);

    expect(missingReason.body.error).toBe('ValidationError');
  });

  it('returns 409 when discarding an emergency that is not pending', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createTestApp({
      sub: 'U000042',
      groups: ['citizen'],
    }, sharedRepo);
    const dispatcherApp = createTestApp({
      sub: 'U000999',
      groups: ['dispatcher'],
    }, sharedRepo);

    const createResponse = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);
    const emergencyId = createResponse.body.emergencyId;

    await request(dispatcherApp)
      .patch(`/api/emergencies/${emergencyId}/discard`)
      .send({ reason: 'Primera revisión' })
      .expect(200);

    const response = await request(dispatcherApp)
      .patch(`/api/emergencies/${emergencyId}/discard`)
      .send({ reason: 'Segundo intento' })
      .expect(409);

    expect(response.body.error).toBe('ConflictError');
  });

  it('cancels a pending emergency using JWT sub as actor, ignoring a spoofed actor in the body', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const ownerApp = createTestApp({
      sub: 'U000042',
      groups: ['citizen'],
    }, sharedRepo);

    const createResponse = await request(ownerApp)
      .post('/api/panic-button')
      .send({
        location: { latitude: -34.6037, longitude: -58.3816 },
      })
      .expect(201);

    const emergencyId = createResponse.body.emergencyId;

    const cancelResponse = await request(ownerApp)
      .patch(`/api/emergencies/${emergencyId}/cancel`)
      .send({ actor: 'spoofed-actor', reason: 'Falsa alarma' })
      .expect(200);

    expect(cancelResponse.body.success).toBe(true);
    expect(cancelResponse.body.data.status).toBe('CANCELLED');
    expect(sharedRepo.updateStatusCalls).toHaveLength(1);
    expect(sharedRepo.updateStatusCalls[0].actor).toBe('U000042');
  });

  it('returns 404 when cancelling a missing emergency', async () => {
    const response = await request(app)
      .patch('/api/emergencies/00000000-0000-0000-0000-000000000000/cancel')
      .send({})
      .expect(404);

    expect(response.body.error).toBe('NotFoundError');
  });

  it('returns 409 when emergency is not cancellable', async () => {
    const createResponse = await request(app)
      .post('/api/panic-button')
      .send({
        location: { latitude: -34.6037, longitude: -58.3816 },
      })
      .expect(201);

    const emergencyId = createResponse.body.emergencyId;

    await request(app)
      .patch(`/api/emergencies/${emergencyId}/cancel`)
      .send({})
      .expect(200);

    const response = await request(app)
      .patch(`/api/emergencies/${emergencyId}/cancel`)
      .send({})
      .expect(409);

    expect(response.body.error).toBe('ConflictError');
  });

  it('returns 403 when citizen tries to cancel another user emergency', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const ownerApp = createTestApp({
      sub: 'U000042',
      groups: ['citizen'],
    }, sharedRepo);
    const otherApp = createTestApp({
      sub: 'U000099',
      groups: ['citizen'],
    }, sharedRepo);

    const createResponse = await request(ownerApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);

    const response = await request(otherApp)
      .patch(`/api/emergencies/${createResponse.body.emergencyId}/cancel`)
      .send({ reason: 'No soy el dueño' })
      .expect(403);

    expect(response.body.error).toBe('ForbiddenError');
  });
});

describe('KafkaService', () => {
  it('throws 503 when publishing while enabled but disconnected', async () => {
    const service = new KafkaService({ enabled: true });

    await expect(service.publishEvent('emergencias.boton-panico', { id: '1' })).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      statusCode: 503,
    });
  });

  it('skips publishing without throwing when disabled', async () => {
    const service = new KafkaService({ enabled: false });

    await expect(service.connect()).resolves.toBe(false);
    await expect(service.publishEvent('emergencias.boton-panico', { id: '1' })).resolves.toBe(false);
    expect(service.isConnected()).toBe(false);
  });

  it('reads KAFKA_ENABLED=false from the environment', () => {
    const previous = process.env.KAFKA_ENABLED;
    process.env.KAFKA_ENABLED = 'false';
    try {
      expect(new KafkaService().isEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KAFKA_ENABLED;
      else process.env.KAFKA_ENABLED = previous;
    }
  });
});

describe('GET /health with Kafka disabled', () => {
  it('reports kafka as disabled instead of disconnected', async () => {
    const disabledApp = createApp(
      { ...mockKafkaService, isEnabled: () => false },
      createMockEmergencyRepository(),
      { authenticate: stubAuthenticate() }
    );

    const response = await request(disabledApp).get('/health').expect(200);

    expect(response.body.kafka).toBe('disabled');
  });
});

describe('GET /health', () => {
  it('reports kafka status from checkHealth', async () => {
    const response = await request(app).get('/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.kafka).toBe('disconnected');
  });
});

describe('GET /api/emergencies', () => {
  it('returns paginated emergencies for the dashboard when called by a dispatcher', async () => {
    const dispatcherApp = createTestApp({
      sub: 'U000999',
      groups: ['dispatcher'],
    });

    const response = await request(dispatcherApp)
      .get('/api/emergencies?status=PENDING,CANCELLED&priority=critical&page=1&limit=20&sortBy=priority')
      .expect(200);

    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 20 });
  });

  it('a citizen can use the listing endpoint but only sees its own emergencies', async () => {
    // El mock repository devuelve todo; lo que se verifica acá es que el
    // endpoint ya no es exclusivo del dispatcher (el scoping se prueba arriba).
    const response = await request(app)
      .get('/api/emergencies')
      .expect(200);

    expect(Array.isArray(response.body.data)).toBe(true);
  });

  it('filtra por emergencyType pasando el alias del front normalizado al repository', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createTestApp({ sub: 'U000042', groups: ['citizen'] }, sharedRepo);
    const dispatcherApp = createTestApp({ sub: 'U000999', groups: ['dispatcher'] }, sharedRepo);

    const medical = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 }, emergencyType: 'medical' })
      .expect(201);
    await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 }, emergencyType: 'fire' })
      .expect(201);

    const response = await request(dispatcherApp)
      .get('/api/emergencies?emergencyType=medical')
      .expect(200);

    expect(sharedRepo.findPageCalls.at(-1)).toMatchObject({ emergencyType: 'MEDICA' });
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ id: medical.body.emergencyId, emergencyType: 'MEDICA' });
  });

  it('mantiene el query param type como alias de emergencyType', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp({ sub: 'U000999', groups: ['dispatcher'] }, sharedRepo);

    await request(dispatcherApp)
      .get('/api/emergencies?type=INCENDIO')
      .expect(200);

    expect(sharedRepo.findPageCalls.at(-1)).toMatchObject({ emergencyType: 'INCENDIO' });
  });

  it('rechaza con 400 un filtro emergencyType fuera del catálogo sin consultar el repository', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const dispatcherApp = createTestApp({ sub: 'U000999', groups: ['dispatcher'] }, sharedRepo);

    const response = await request(dispatcherApp)
      .get('/api/emergencies?emergencyType=flood')
      .expect(400);

    expect(response.body.error).toBe('ValidationError');
    expect(sharedRepo.findPageCalls).toHaveLength(0);
  });
});

describe('Emergencies API - máquina de estados', () => {
  // Deja una emergencia creada por el citizen en el estado pedido, forzando
  // el estado en el mock (sin pasar por el controller).
  async function createEmergencyInStatus(sharedRepo, citizenApp, status) {
    const createResponse = await request(citizenApp)
      .post('/api/panic-button')
      .send({ location: { latitude: -34.6037, longitude: -58.3816 } })
      .expect(201);
    const emergencyId = createResponse.body.emergencyId;
    const current = await sharedRepo.findById(emergencyId);
    current.status = status;
    sharedRepo.updateStatusCalls.length = 0;
    return emergencyId;
  }

  it('returns 409 when validating a terminal (CANCELLED) emergency and does not touch the repository', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createTestApp({ sub: 'U000042', groups: ['citizen'] }, sharedRepo);
    const dispatcherApp = createTestApp({ sub: 'U000999', groups: ['dispatcher'] }, sharedRepo);
    const emergencyId = await createEmergencyInStatus(sharedRepo, citizenApp, 'CANCELLED');

    const response = await request(dispatcherApp)
      .patch(`/api/emergencies/${emergencyId}/validate`)
      .expect(409);

    expect(response.body).toEqual({
      error: 'ConflictError',
      message: 'Emergency in terminal status CANCELLED cannot transition to VALIDATED',
    });
    expect(sharedRepo.updateStatusCalls).toHaveLength(0);
  });

  it('returns 409 when discarding a VALIDATED emergency (only PENDING can be discarded)', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createTestApp({ sub: 'U000042', groups: ['citizen'] }, sharedRepo);
    const dispatcherApp = createTestApp({ sub: 'U000999', groups: ['dispatcher'] }, sharedRepo);
    const emergencyId = await createEmergencyInStatus(sharedRepo, citizenApp, 'VALIDATED');

    const response = await request(dispatcherApp)
      .patch(`/api/emergencies/${emergencyId}/discard`)
      .send({ reason: 'Ya fue validada' })
      .expect(409);

    expect(response.body).toEqual({
      error: 'ConflictError',
      message: 'Invalid transition VALIDATED → DISCARDED',
    });
    expect(sharedRepo.updateStatusCalls).toHaveLength(0);
  });

  it('allows a citizen to cancel a VALIDATED emergency but not a DISPATCHED one', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createTestApp({ sub: 'U000042', groups: ['citizen'] }, sharedRepo);

    const validatedId = await createEmergencyInStatus(sharedRepo, citizenApp, 'VALIDATED');
    const okResponse = await request(citizenApp)
      .patch(`/api/emergencies/${validatedId}/cancel`)
      .send({ reason: 'Ya no hace falta' })
      .expect(200);
    expect(okResponse.body.data.status).toBe('CANCELLED');

    const dispatchedId = await createEmergencyInStatus(sharedRepo, citizenApp, 'DISPATCHED');
    const response = await request(citizenApp)
      .patch(`/api/emergencies/${dispatchedId}/cancel`)
      .send({ reason: 'Tarde' })
      .expect(409);

    expect(response.body).toEqual({
      error: 'ConflictError',
      message: 'Invalid transition DISPATCHED → CANCELLED',
    });
    expect(sharedRepo.updateStatusCalls).toHaveLength(0);
  });

  it('returns 409 when cancelling a terminal (DISCARDED) emergency', async () => {
    const sharedRepo = createMockEmergencyRepository();
    const citizenApp = createTestApp({ sub: 'U000042', groups: ['citizen'] }, sharedRepo);
    const emergencyId = await createEmergencyInStatus(sharedRepo, citizenApp, 'DISCARDED');

    const response = await request(citizenApp)
      .patch(`/api/emergencies/${emergencyId}/cancel`)
      .send({})
      .expect(409);

    expect(response.body).toEqual({
      error: 'ConflictError',
      message: 'Emergency in terminal status DISCARDED cannot transition to CANCELLED',
    });
  });
});
