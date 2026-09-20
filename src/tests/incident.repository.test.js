const { IncidentRepository, mapIncident } = require('../repositories/incident.repository');
const { NotFoundError } = require('../errors/app-errors');

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

// Cliente de transacción para applyScoringDecision: soporta BEGIN/COMMIT/
// ROLLBACK igual que el resto del repo (ver createClient en
// emergency.repository.test.js) y delega el resto (SELECT ... FOR UPDATE,
// UPDATE) al handler que arma cada test.
function createTxClient(handler) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/^BEGIN$/.test(sql) || /^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) return { rows: [] };
      return handler(sql, params);
    }),
    release: jest.fn(),
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

  describe('findActivePage', () => {
    it('devuelve incidentes activos paginados con la cantidad de emergencias de cada uno', async () => {
      const calls = [];
      const pool = {
        query: async (sql, params) => {
          calls.push({ sql, params });
          if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
          return { rows: [{ id: 'i-4', emergency_type: 'PANICO', priority: 'high', emergency_count: 3 }] };
        },
      };
      const repo = new IncidentRepository(pool);

      const { incidents, total } = await repo.findActivePage({ page: 2, limit: 5 });

      expect(total).toBe(1);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ id: 'i-4', priority: 'high', emergencyCount: 3 });
      expect(calls[1].sql).toMatch(/LIMIT \$1 OFFSET \$2/);
      expect(calls[1].params).toEqual([5, 5]);
    });

    it('usa page=1 y limit=20 por defecto', async () => {
      const calls = [];
      const pool = {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return sql.includes('COUNT(*)::int AS total') ? { rows: [{ total: 0 }] } : { rows: [] };
        },
      };
      const repo = new IncidentRepository(pool);

      await repo.findActivePage();

      expect(calls[1].params).toEqual([20, 0]);
    });
  });

  describe('findByIdWithMembers', () => {
    it('devuelve null si el incidente no existe', async () => {
      const pool = { query: async () => ({ rows: [] }) };
      const repo = new IncidentRepository(pool);

      expect(await repo.findByIdWithMembers('missing')).toBeNull();
    });

    it('devuelve el incidente con sus emergencias miembro (sin coordenadas)', async () => {
      let call = 0;
      const pool = {
        query: async () => {
          call += 1;
          if (call === 1) return { rows: [{ id: 'inc-1', emergency_type: 'INCENDIO', priority: 'high' }] };
          return {
            rows: [
              { id: 'e1', status: 'VALIDATED', emergency_type: 'INCENDIO', created_at: 'c1' },
              { id: 'e2', status: 'DISPATCHED', emergency_type: 'INCENDIO', created_at: 'c2' },
            ],
          };
        },
      };
      const repo = new IncidentRepository(pool);

      const detail = await repo.findByIdWithMembers('inc-1');

      expect(detail.id).toBe('inc-1');
      expect(detail.priority).toBe('high');
      expect(detail.members).toEqual([
        { id: 'e1', status: 'VALIDATED', emergencyType: 'INCENDIO', createdAt: 'c1' },
        { id: 'e2', status: 'DISPATCHED', emergencyType: 'INCENDIO', createdAt: 'c2' },
      ]);
      expect(detail.members.every((m) => !('latitude' in m) && !('longitude' in m))).toBe(true);
    });
  });

  it('addMember delega en emergencyRepository.setIncidentId', async () => {
    const pool = createPool([]);
    const emergencyRepository = { setIncidentId: jest.fn().mockResolvedValue({ id: 'e-1', incidentId: 'i-5' }) };
    const repo = new IncidentRepository(pool, emergencyRepository);

    const result = await repo.addMember('i-5', 'e-1');

    expect(emergencyRepository.setIncidentId).toHaveBeenCalledWith('e-1', 'i-5');
    expect(result).toEqual({ id: 'e-1', incidentId: 'i-5' });
  });

  describe('applyScoringDecision', () => {
    function updatedRow(overrides = {}) {
      return {
        id: 'inc-1',
        emergency_type: 'PANICO',
        priority: 'high',
        score: 90,
        reason_codes: ['MULTI_REPORT_THRESHOLD'],
        factors: { reportCount: 2 },
        algorithm_version: 'rule-based-v1',
        created_at: 'c',
        updated_at: 'u',
        ...overrides,
      };
    }

    it('actualiza el incidente y dispara EmergenciaPriorizada por cada miembro cuando la prioridad cambió', async () => {
      const client = createTxClient((sql) => {
        if (/SELECT priority FROM incidents/.test(sql)) return { rows: [{ priority: 'low' }] };
        if (/UPDATE incidents/.test(sql)) return { rows: [updatedRow()] };
        throw new Error(`query inesperada: ${sql}`);
      });
      const pool = { connect: jest.fn(async () => client) };
      const emergencyRepository = { insertOutboxEvent: jest.fn().mockResolvedValue() };
      const repo = new IncidentRepository(pool, emergencyRepository);

      const members = [
        { emergencyId: 'e1', correlationId: 'c1', priorityIndividual: 'low', finalPriority: 'high' },
        { emergencyId: 'e2', correlationId: 'c2', priorityIndividual: 'low', finalPriority: 'high' },
      ];

      const result = await repo.applyScoringDecision('inc-1', {
        priority: 'high', score: 90, reasonCodes: ['MULTI_REPORT_THRESHOLD'], factors: { reportCount: 2 }, algorithmVersion: 'rule-based-v1', members,
      });

      expect(result).toEqual({
        id: 'inc-1',
        emergencyType: 'PANICO',
        priority: 'high',
        score: 90,
        reasonCodes: ['MULTI_REPORT_THRESHOLD'],
        factors: { reportCount: 2 },
        algorithmVersion: 'rule-based-v1',
        createdAt: 'c',
        updatedAt: 'u',
      });
      expect(emergencyRepository.insertOutboxEvent).toHaveBeenCalledTimes(2);
      expect(emergencyRepository.insertOutboxEvent).toHaveBeenNthCalledWith(1, client, expect.any(Object), members[0]);
      expect(emergencyRepository.insertOutboxEvent).toHaveBeenNthCalledWith(2, client, expect.any(Object), members[1]);
      expect(client.calls.map((c) => c.sql.trim().split('\n')[0])).toContain('BEGIN');
      expect(client.calls.map((c) => c.sql.trim())).toContain('COMMIT');
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('actualiza con defaults (null) cuando faltan priority/score/reasonCodes/factors/algorithmVersion', async () => {
      let updateParams;
      const client = createTxClient((sql, params) => {
        if (/SELECT priority FROM incidents/.test(sql)) return { rows: [{ priority: null }] };
        if (/UPDATE incidents/.test(sql)) {
          updateParams = params;
          return { rows: [updatedRow({ priority: null, score: null, reason_codes: null, factors: null, algorithm_version: null })] };
        }
        throw new Error(`query inesperada: ${sql}`);
      });
      const pool = { connect: jest.fn(async () => client) };
      const emergencyRepository = { insertOutboxEvent: jest.fn().mockResolvedValue() };
      const repo = new IncidentRepository(pool, emergencyRepository);

      await repo.applyScoringDecision('inc-1', {
        priority: undefined, score: undefined, reasonCodes: undefined, factors: undefined, algorithmVersion: undefined, members: [],
      });

      expect(updateParams).toEqual([null, null, 'null', 'null', null, 'inc-1']);
      // priority pasó de null a null: sigue siendo "distinto" según el
      // comentario del método solo cuando cambia; acá no cambia, así que no
      // debería haber notificado (members está vacío de todas formas).
      expect(emergencyRepository.insertOutboxEvent).not.toHaveBeenCalled();
    });

    it('el builder de payload arma el evento EmergenciaPriorizada con los datos del miembro y del incidente', async () => {
      const client = createTxClient((sql) => {
        if (/SELECT priority FROM incidents/.test(sql)) return { rows: [{ priority: 'low' }] };
        if (/UPDATE incidents/.test(sql)) return { rows: [updatedRow()] };
        throw new Error(`query inesperada: ${sql}`);
      });
      const pool = { connect: jest.fn(async () => client) };
      const emergencyRepository = { insertOutboxEvent: jest.fn().mockResolvedValue() };
      const repo = new IncidentRepository(pool, emergencyRepository);

      const member = {
        emergencyId: 'e1', correlationId: 'c1', priorityIndividual: 'low', finalPriority: 'high',
      };

      await repo.applyScoringDecision('inc-1', {
        priority: 'high', score: 90, reasonCodes: ['MULTI_REPORT_THRESHOLD'], factors: { reportCount: 2 }, algorithmVersion: 'rule-based-v1', members: [member],
      });

      const [, outboxEvent, entity] = emergencyRepository.insertOutboxEvent.mock.calls[0];
      expect(outboxEvent.topic).toBe(process.env.TOPIC_EMERGENCIA_PRIORIZADA || 'emergencias.priorizada');
      const eventPayload = outboxEvent.payload(entity, 'event-id-1');
      expect(eventPayload).toMatchObject({
        type: 'EmergenciaPriorizada',
        eventId: 'event-id-1',
        correlationId: 'c1',
        data: {
          id: 'e1',
          correlationId: 'c1',
          incidentId: 'inc-1',
          priorityIndividual: 'low',
          incidentPriority: 'high',
          priority: 'high',
          score: 90,
          reasonCodes: ['MULTI_REPORT_THRESHOLD'],
          algorithmVersion: 'rule-based-v1',
        },
      });
    });

    it('no dispara ningún evento si la prioridad no cambió', async () => {
      const client = createTxClient((sql) => {
        if (/SELECT priority FROM incidents/.test(sql)) return { rows: [{ priority: 'high' }] };
        if (/UPDATE incidents/.test(sql)) return { rows: [updatedRow()] };
        throw new Error(`query inesperada: ${sql}`);
      });
      const pool = { connect: jest.fn(async () => client) };
      const emergencyRepository = { insertOutboxEvent: jest.fn() };
      const repo = new IncidentRepository(pool, emergencyRepository);

      const result = await repo.applyScoringDecision('inc-1', {
        priority: 'high', score: 90, reasonCodes: [], factors: {}, algorithmVersion: 'rule-based-v1', members: [{ emergencyId: 'e1' }],
      });

      expect(result.priority).toBe('high');
      expect(emergencyRepository.insertOutboxEvent).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('la primera vez (priority previo NULL) siempre notifica, aunque la nueva priority sea "low"', async () => {
      const client = createTxClient((sql) => {
        if (/SELECT priority FROM incidents/.test(sql)) return { rows: [{ priority: null }] };
        if (/UPDATE incidents/.test(sql)) return { rows: [updatedRow({ priority: 'low' })] };
        throw new Error(`query inesperada: ${sql}`);
      });
      const pool = { connect: jest.fn(async () => client) };
      const emergencyRepository = { insertOutboxEvent: jest.fn().mockResolvedValue() };
      const repo = new IncidentRepository(pool, emergencyRepository);

      await repo.applyScoringDecision('inc-1', {
        priority: 'low', score: 5, reasonCodes: [], factors: {}, algorithmVersion: 'rule-based-v1', members: [{ emergencyId: 'e1' }],
      });

      expect(emergencyRepository.insertOutboxEvent).toHaveBeenCalledTimes(1);
    });

    it('lanza NotFoundError y hace ROLLBACK si el incidente no existe', async () => {
      const client = createTxClient((sql) => {
        if (/SELECT priority FROM incidents/.test(sql)) return { rows: [] };
        throw new Error('no debería llegar a la query de UPDATE');
      });
      const pool = { connect: jest.fn(async () => client) };
      const emergencyRepository = { insertOutboxEvent: jest.fn() };
      const repo = new IncidentRepository(pool, emergencyRepository);

      await expect(repo.applyScoringDecision('missing', {
        priority: 'low', score: 1, reasonCodes: [], factors: {}, algorithmVersion: 'v', members: [],
      })).rejects.toThrow(NotFoundError);

      expect(client.calls.map((c) => c.sql.trim())).toContain('ROLLBACK');
      expect(emergencyRepository.insertOutboxEvent).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('propaga el error y hace ROLLBACK si insertOutboxEvent falla', async () => {
      const client = createTxClient((sql) => {
        if (/SELECT priority FROM incidents/.test(sql)) return { rows: [{ priority: 'low' }] };
        if (/UPDATE incidents/.test(sql)) return { rows: [updatedRow()] };
        throw new Error(`query inesperada: ${sql}`);
      });
      const pool = { connect: jest.fn(async () => client) };
      const emergencyRepository = { insertOutboxEvent: jest.fn().mockRejectedValue(new Error('outbox down')) };
      const repo = new IncidentRepository(pool, emergencyRepository);

      await expect(repo.applyScoringDecision('inc-1', {
        priority: 'high', score: 90, reasonCodes: [], factors: {}, algorithmVersion: 'v', members: [{ emergencyId: 'e1' }],
      })).rejects.toThrow('outbox down');

      expect(client.calls.map((c) => c.sql.trim())).toContain('ROLLBACK');
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });
});
