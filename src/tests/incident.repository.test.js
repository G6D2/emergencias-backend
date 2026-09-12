const { IncidentRepository, mapIncident } = require('../repositories/incident.repository');

function createPool(rows) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows };
    },
  };
}

describe('mapIncident', () => {
  it('devuelve null si no hay fila', () => {
    expect(mapIncident(null)).toBeNull();
  });

  it('mapea snake_case a camelCase', () => {
    const mapped = mapIncident({
      id: 'i-1',
      emergency_type: 'PANICO',
      priority: 'high',
      score: 0.9,
      reason_codes: ['a'],
      algorithm_version: 'v1',
      created_at: 'c',
      updated_at: 'u',
    });
    expect(mapped).toEqual({
      id: 'i-1',
      emergencyType: 'PANICO',
      priority: 'high',
      score: 0.9,
      reasonCodes: ['a'],
      algorithmVersion: 'v1',
      createdAt: 'c',
      updatedAt: 'u',
    });
  });
});

describe('IncidentRepository', () => {
  it('create inserta con defaults cuando faltan campos opcionales', async () => {
    const pool = createPool([{ id: 'i-2', emergency_type: null, priority: null, score: null, reason_codes: null, algorithm_version: null }]);
    const repo = new IncidentRepository(pool);

    const incident = await repo.create({});

    expect(incident.id).toBe('i-2');
    expect(pool.queries[0].params).toEqual([null, null, null, 'null', null]);
  });

  it('create inserta con todos los campos', async () => {
    const pool = createPool([{ id: 'i-3', emergency_type: 'PANICO', priority: 'high', score: 0.5, reason_codes: ['x'], algorithm_version: 'v2' }]);
    const repo = new IncidentRepository(pool);

    const incident = await repo.create({
      emergencyType: 'PANICO', priority: 'high', score: 0.5, reasonCodes: ['x'], algorithmVersion: 'v2',
    });

    expect(incident.priority).toBe('high');
    expect(pool.queries[0].params).toEqual(['PANICO', 'high', 0.5, JSON.stringify(['x']), 'v2']);
  });

  it('findActive devuelve incidentes activos mapeados', async () => {
    const pool = createPool([{ id: 'i-4', emergency_type: 'PANICO' }]);
    const repo = new IncidentRepository(pool);

    const incidents = await repo.findActive();

    expect(incidents).toHaveLength(1);
    expect(incidents[0].id).toBe('i-4');
  });

  it('addMember delega en emergencyRepository.setIncidentId', async () => {
    const pool = createPool([]);
    const emergencyRepository = { setIncidentId: jest.fn().mockResolvedValue({ id: 'e-1', incidentId: 'i-5' }) };
    const repo = new IncidentRepository(pool, emergencyRepository);

    const result = await repo.addMember('i-5', 'e-1');

    expect(emergencyRepository.setIncidentId).toHaveBeenCalledWith('e-1', 'i-5');
    expect(result).toEqual({ id: 'e-1', incidentId: 'i-5' });
  });
});
