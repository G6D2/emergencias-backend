const { OfficerRepository, mapOfficer } = require('../repositories/officer.repository');

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

describe('mapOfficer', () => {
  it('devuelve null si no hay fila', () => {
    expect(mapOfficer(null)).toBeNull();
    expect(mapOfficer(undefined)).toBeNull();
  });

  it('mapea snake_case a camelCase', () => {
    const mapped = mapOfficer({
      id: 'o-1',
      name: 'Juan',
      badge_number: 'B-1',
      location_label: 'Centro',
      distance_label: '1km',
      status: 'disponible',
      created_at: 'c',
      updated_at: 'u',
    });
    expect(mapped).toEqual({
      id: 'o-1',
      name: 'Juan',
      badgeNumber: 'B-1',
      location: 'Centro',
      distance: '1km',
      status: 'disponible',
      createdAt: 'c',
      updatedAt: 'u',
    });
  });
});

describe('OfficerRepository', () => {
  it('findAll sin filtro consulta todos los oficiales', async () => {
    const pool = createPool([{ id: 'o-1', name: 'Juan', status: 'disponible' }]);
    const repo = new OfficerRepository(pool);

    const officers = await repo.findAll();

    expect(officers).toHaveLength(1);
    expect(officers[0].id).toBe('o-1');
    expect(pool.queries[0].sql).not.toMatch(/WHERE/);
    expect(pool.queries[0].params).toEqual([]);
  });

  it('findAll con status agrega el filtro WHERE', async () => {
    const pool = createPool([{ id: 'o-2', name: 'Ana', status: 'ocupado' }]);
    const repo = new OfficerRepository(pool);

    const officers = await repo.findAll({ status: 'ocupado' });

    expect(officers).toHaveLength(1);
    expect(pool.queries[0].sql).toMatch(/WHERE status = \$1/);
    expect(pool.queries[0].params).toEqual(['ocupado']);
  });
});
