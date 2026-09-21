const request = require('supertest');
const { createApp } = require('../app');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

function stubAuthenticate(user = { sub: 'D000001', groups: ['dispatcher'] }) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

function createMockIncidentRepository({ incidents = [], detailById = {} } = {}) {
  return {
    findActivePage: async ({ page, limit } = {}) => {
      const start = (page - 1) * limit;
      return {
        incidents: incidents.slice(start, start + limit),
        total: incidents.length,
      };
    },
    findByIdWithMembers: async (id) => detailById[id] || null,
  };
}

describe('GET /api/incidents', () => {
  it('lista incidentes activos paginados para un dispatcher', async () => {
    const incidentRepository = createMockIncidentRepository({
      incidents: [
        {
          id: 'inc-1', emergencyType: 'INCENDIO', priority: 'critical', score: 90, reasonCodes: ['MULTI_REPORT_THRESHOLD'], emergencyCount: 3, createdAt: 'c', updatedAt: 'u',
        },
      ],
    });
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(),
      incidentRepository,
    });

    const response = await request(app).get('/api/incidents').expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      id: 'inc-1', priority: 'critical', emergencyCount: 3,
    });
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('acepta page y limit por query string', async () => {
    const incidentRepository = createMockIncidentRepository({
      incidents: Array.from({ length: 5 }, (_, i) => ({ id: `inc-${i}`, priority: 'low' })),
    });
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(),
      incidentRepository,
    });

    const response = await request(app).get('/api/incidents?page=2&limit=2').expect(200);

    expect(response.body.pagination).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });

  it('prohíbe a un citizen listar incidentes', async () => {
    const incidentRepository = createMockIncidentRepository();
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate({ sub: 'U1', groups: ['citizen'] }),
      incidentRepository,
    });

    await request(app).get('/api/incidents').expect(403);
  });

  it('devuelve 401 sin autenticar', async () => {
    const incidentRepository = createMockIncidentRepository();
    const app = createApp(mockKafkaService, {}, {
      authenticate: (req, res, next) => next(),
      incidentRepository,
    });

    await request(app).get('/api/incidents').expect(401);
  });

  it('no monta la ruta si no hay incidentRepository (compatibilidad)', async () => {
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(),
    });

    await request(app).get('/api/incidents').expect(404);
  });
});

describe('GET /api/incidents/:id', () => {
  const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

  it('devuelve el incidente con sus emergencias miembro, sin coordenadas', async () => {
    const incidentRepository = createMockIncidentRepository({
      detailById: {
        [VALID_UUID]: {
          id: VALID_UUID,
          emergencyType: 'INCENDIO',
          priority: 'high',
          score: 60,
          reasonCodes: [],
          createdAt: 'c',
          updatedAt: 'u',
          members: [
            {
              id: 'e-1', status: 'VALIDATED', emergencyType: 'INCENDIO', createdAt: 'c1',
            },
          ],
        },
      },
    });
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(),
      incidentRepository,
    });

    const response = await request(app).get(`/api/incidents/${VALID_UUID}`).expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.id).toBe(VALID_UUID);
    expect(response.body.data.members).toEqual([
      {
        id: 'e-1', status: 'VALIDATED', emergencyType: 'INCENDIO', createdAt: 'c1',
      },
    ]);
    expect(response.body.data.members[0]).not.toHaveProperty('latitude');
    expect(response.body.data.members[0]).not.toHaveProperty('longitude');
  });

  it('devuelve 404 unificado si el incidente no existe', async () => {
    const incidentRepository = createMockIncidentRepository();
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(),
      incidentRepository,
    });

    const response = await request(app).get(`/api/incidents/${VALID_UUID}`).expect(404);
    expect(response.body.error).toBe('NotFoundError');
  });

  it('devuelve 400 si el id no es un UUID válido', async () => {
    const incidentRepository = createMockIncidentRepository();
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(),
      incidentRepository,
    });

    const response = await request(app).get('/api/incidents/not-a-uuid').expect(400);
    expect(response.body.error).toBe('ValidationError');
  });

  it('prohíbe a un citizen ver el detalle de un incidente', async () => {
    const incidentRepository = createMockIncidentRepository({
      detailById: { [VALID_UUID]: { id: VALID_UUID, members: [] } },
    });
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate({ sub: 'U1', groups: ['citizen'] }),
      incidentRepository,
    });

    await request(app).get(`/api/incidents/${VALID_UUID}`).expect(403);
  });
});
