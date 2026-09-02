const request = require('supertest');
const { createApp } = require('../app');
const { KafkaService } = require('../services/kafka.service');
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
      const saved = { ...emergency };
      emergencies.set(saved.id, saved);
      return saved;
    },
    findById: async (id) => emergencies.get(id) || null,
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
    findPage: async () => ({ emergencies: [...emergencies.values()], total: emergencies.size }),
  };
}

const app = createApp(mockKafkaService, createMockEmergencyRepository());

describe('Panic Button API', () => {
  describe('POST /api/panic-button', () => {
    it('should trigger panic button successfully', async () => {
      const payload = {
        userId: 'user-123',
        location: {
          lat: -34.6037,
          lng: -58.3816,
        },
        description: 'Test panic button',
      };

      const response = await request(app)
        .post('/api/panic-button')
        .send(payload)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.emergencyId).toBeDefined();
      expect(response.body.data.userId).toBe(payload.userId);
      expect(response.body.data.status).toBe('PENDING');
    });

    it('should fail without required fields', async () => {
      const payload = {
        description: 'Missing userId and location',
      };

      const response = await request(app)
        .post('/api/panic-button')
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe('ValidationError');
    });
  });

  describe('GET /api/panic-button/:id', () => {
    it('should retrieve panic button event', async () => {
      const createResponse = await request(app)
        .post('/api/panic-button')
        .send({
          userId: 'user-456',
          location: { lat: -34.6037, lng: -58.3816 },
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
  });
});

describe('Emergencies API', () => {
  it('cancels a pending emergency', async () => {
    const createResponse = await request(app)
      .post('/api/panic-button')
      .send({
        userId: 'user-789',
        location: { lat: -34.6037, lng: -58.3816 },
      })
      .expect(201);

    const emergencyId = createResponse.body.emergencyId;

    const cancelResponse = await request(app)
      .patch(`/api/emergencies/${emergencyId}/cancel`)
      .send({ actor: 'user-789', reason: 'Falsa alarma' })
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
        userId: 'user-conflict',
        location: { lat: -34.6037, lng: -58.3816 },
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

describe('GET /api/emergencies', () => {
  it('returns paginated emergencies for the dashboard', async () => {
    const response = await request(app)
      .get('/api/emergencies?status=PENDING,CANCELLED&priority=critical&page=1&limit=20&sortBy=priority')
      .expect(200);

    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 20 });
  });
});
