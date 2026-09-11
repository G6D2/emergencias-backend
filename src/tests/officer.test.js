const request = require('supertest');
const { createApp } = require('../app');
const { NotFoundError, ConflictError } = require('../errors/app-errors');

const mockKafkaService = {
  publishEvent: async () => {},
  isConnected: () => true,
  checkHealth: async () => false,
};

function stubAuthenticate(user = {
  sub: 'U000999',
  groups: ['dispatcher'],
  username: 'operador1',
}) {
  return (req, res, next) => {
    req.user = user;
    next();
  };
}

function createMockOfficerRepository(initial = []) {
  const officers = new Map(initial.map((o) => [o.id, { ...o }]));

  return {
    findAll: async ({ status } = {}) => {
      const all = [...officers.values()];
      return status ? all.filter((o) => o.status === status) : all;
    },
    findById: async (id) => officers.get(id) || null,
    _officers: officers,
  };
}

describe('GET /api/officers', () => {
  it('lists officers for a dispatcher', async () => {
    const officerRepository = createMockOfficerRepository([
      {
        id: 'of-001',
        name: 'Oficial Carlos Gómez',
        badgeNumber: 'CP-4021',
        location: 'Av. 9 de Julio y Corrientes',
        distance: '350 m',
        status: 'disponible',
      },
    ]);
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate(),
      officerRepository,
    });

    const response = await request(app).get('/api/officers').expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      id: 'of-001',
      name: 'Oficial Carlos Gómez',
      badgeNumber: 'CP-4021',
      status: 'disponible',
    });
  });

  it('forbids citizens from listing officers', async () => {
    const officerRepository = createMockOfficerRepository([]);
    const app = createApp(mockKafkaService, {}, {
      authenticate: stubAuthenticate({ sub: 'U1', groups: ['citizen'] }),
      officerRepository,
    });

    await request(app).get('/api/officers').expect(403);
  });
});

describe('PATCH /api/emergencies/:id/assign', () => {
  function createRepos() {
    const emergencies = new Map();
    const officers = new Map([
      ['of-001', {
        id: 'of-001',
        name: 'Oficial Carlos Gómez',
        badgeNumber: 'CP-4021',
        location: 'Centro',
        distance: '100 m',
        status: 'disponible',
      }],
      ['of-busy', {
        id: 'of-busy',
        name: 'Oficial Ocupado',
        badgeNumber: 'CP-0001',
        location: 'Sur',
        distance: '2 km',
        status: 'ocupado',
      }],
    ]);
    const updateStatusCalls = [];

    const emergencyRepository = {
      updateStatusCalls,
      findById: async (id) => emergencies.get(id) || null,
      assignOfficer: async (id, { officerId, actor, outboxEvent }) => {
        const emergency = emergencies.get(id);
        if (!emergency) throw new NotFoundError(`Emergency with ID ${id} not found`);
        const officer = officers.get(officerId);
        if (!officer) throw new NotFoundError(`Officer with ID ${officerId} not found`);
        if (officer.status !== 'disponible') {
          throw new ConflictError(`Officer ${officerId} is not available`);
        }
        officer.status = 'ocupado';
        const updated = {
          ...emergency,
          status: 'DISPATCHED',
          assignedOfficerId: officerId,
          updatedAt: new Date().toISOString(),
        };
        emergencies.set(id, updated);
        updateStatusCalls.push({ id, officerId, actor, outboxEvent });
        return {
          emergency: updated,
          history: {
            previousStatus: emergency.status,
            newStatus: 'DISPATCHED',
            actor,
          },
          officer: { ...officer },
        };
      },
    };

    return {
      emergencies,
      officers,
      emergencyRepository,
      officerRepository: {
        findAll: async () => [...officers.values()],
        findById: async (id) => officers.get(id) || null,
      },
    };
  }

  it('assigns an available officer and returns DISPATCHED with assignedOfficer name', async () => {
    const { emergencies, emergencyRepository, officerRepository } = createRepos();
    const id = '550e8400-e29b-41d4-a716-446655440000';
    emergencies.set(id, {
      id,
      userId: 'U000042',
      status: 'VALIDATED',
      assignedOfficerId: null,
    });

    const app = createApp(mockKafkaService, emergencyRepository, {
      authenticate: stubAuthenticate(),
      officerRepository,
    });

    const response = await request(app)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: 'of-001' })
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      data: {
        status: 'DISPATCHED',
        assignedOfficerId: 'of-001',
        assignedOfficer: 'Oficial Carlos Gómez',
      },
    });
    expect(emergencyRepository.updateStatusCalls).toHaveLength(1);
  });

  it('returns 409 when the officer is ocupado', async () => {
    const { emergencies, emergencyRepository, officerRepository } = createRepos();
    const id = '550e8400-e29b-41d4-a716-446655440001';
    emergencies.set(id, { id, userId: 'U1', status: 'VALIDATED' });

    const app = createApp(mockKafkaService, emergencyRepository, {
      authenticate: stubAuthenticate(),
      officerRepository,
    });

    const response = await request(app)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: 'of-busy' })
      .expect(409);

    expect(response.body.message).toMatch(/not available/i);
  });

  it('returns 409 when emergency is not VALIDATED', async () => {
    const { emergencies, emergencyRepository, officerRepository } = createRepos();
    const id = '550e8400-e29b-41d4-a716-446655440002';
    emergencies.set(id, { id, userId: 'U1', status: 'PENDING' });

    const app = createApp(mockKafkaService, emergencyRepository, {
      authenticate: stubAuthenticate(),
      officerRepository,
    });

    await request(app)
      .patch(`/api/emergencies/${id}/assign`)
      .send({ officerId: 'of-001' })
      .expect(409);
  });

  it('requires officerId', async () => {
    const { emergencies, emergencyRepository, officerRepository } = createRepos();
    const id = '550e8400-e29b-41d4-a716-446655440003';
    emergencies.set(id, { id, userId: 'U1', status: 'VALIDATED' });

    const app = createApp(mockKafkaService, emergencyRepository, {
      authenticate: stubAuthenticate(),
      officerRepository,
    });

    await request(app)
      .patch(`/api/emergencies/${id}/assign`)
      .send({})
      .expect(400);
  });
});
