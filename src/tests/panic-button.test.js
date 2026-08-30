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

  return {
    create: async (emergency) => {
      const saved = {
        ...emergency,
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
    updateStatus: async (id, { newStatus, actor = null, reason = null }) => {
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
      expect(response.body.data.status).toBe('CREATED');
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
  it('cancels a pending emergency using JWT sub as actor', async () => {
    const createResponse = await request(app)
      .post('/api/panic-button')
      .send({
        location: { latitude: -34.6037, longitude: -58.3816 },
      })
      .expect(201);

    const emergencyId = createResponse.body.emergencyId;

    const cancelResponse = await request(app)
      .patch(`/api/emergencies/${emergencyId}/cancel`)
      .send({ actor: 'spoofed-actor', reason: 'Falsa alarma' })
      .expect(200);

    expect(cancelResponse.body.success).toBe(true);
    expect(cancelResponse.body.data.status).toBe('CANCELLED');
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
  it('throws 503 when publishing while disconnected', async () => {
    const service = new KafkaService();

    await expect(service.publishEvent('emergencias.boton-panico', { id: '1' })).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      statusCode: 503,
    });
  });
});

describe('GET /health', () => {
  it('reports kafka status from checkHealth', async () => {
    const response = await request(app).get('/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.kafka).toBe('disconnected');
  });
});
