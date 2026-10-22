const { activateAndDiscardStalePending } = require('../../integracion/listener-activation');

// Mock utils: client transaccional capaz de registrar las queries ejecutadas
// y responder segun el SQL. Usado para simular el flujo transaccional.
function makeTxClient(queryImpl) {
  const client = {
    calls: [],
    released: false,
    query: jest.fn().mockImplementation(async (sql, params) => {
      client.calls.push({ sql, params });
      return queryImpl(sql, params);
    }),
    release: jest.fn().mockImplementation(() => { client.released = true; }),
  };
  return client;
}

describe('activateAndDiscardStalePending', () => {
  describe('fast-path (ya habia fila)', () => {
    it('devuelve firstActivation=false sin tocar emergencias', async () => {
      const existingDate = new Date('2026-10-22T12:00:00Z');
      const repo = {
        get: jest.fn().mockResolvedValue({
          firstActivatedAt: existingDate,
          discardedCount: 2,
        }),
        tryInsertFirstActivation: jest.fn(),
        setDiscardedCount: jest.fn(),
      };
      const pool = { connect: jest.fn() };

      const result = await activateAndDiscardStalePending({ pool, repo });

      expect(result).toEqual({
        firstActivation: false,
        firstActivatedAt: existingDate,
        discardedCount: 2,
        discardedIds: [],
      });
      expect(pool.connect).not.toHaveBeenCalled();
      expect(repo.tryInsertFirstActivation).not.toHaveBeenCalled();
    });
  });

  describe('primera activacion (gana el candado)', () => {
    it('inserta activacion, descarta PENDING externas previas y guarda la cuenta', async () => {
      const firstActivatedAt = new Date('2026-10-22T12:00:00Z');
      const repo = {
        get: jest.fn().mockResolvedValue(null),
        tryInsertFirstActivation: jest.fn().mockResolvedValue({ firstActivatedAt }),
        setDiscardedCount: jest.fn().mockResolvedValue(undefined),
      };

      const client = makeTxClient(async (sql) => {
        if (/UPDATE emergencies/.test(sql)) {
          return { rowCount: 2, rows: [{ id: 'em-1' }, { id: 'em-2' }] };
        }
        return {};
      });
      const pool = { connect: jest.fn().mockResolvedValue(client) };

      const result = await activateAndDiscardStalePending({ pool, repo });

      expect(result).toEqual({
        firstActivation: true,
        firstActivatedAt,
        discardedCount: 2,
        discardedIds: ['em-1', 'em-2'],
      });

      // BEGIN primero, UPDATE emergencies con el timestamp, UPDATE discarded_count via repo, COMMIT.
      const sqls = client.calls.map((c) => c.sql);
      expect(sqls[0]).toMatch(/BEGIN/);
      const updateCall = client.calls.find((c) => /UPDATE emergencies/.test(c.sql));
      expect(updateCall).toBeDefined();
      expect(updateCall.sql).toMatch(/status = 'DISCARDED'/);
      expect(updateCall.sql).toMatch(/source = 'EXTERNAL'/);
      expect(updateCall.sql).toMatch(/status = 'PENDING'/);
      expect(updateCall.sql).toMatch(/created_at < \$1/);
      expect(updateCall.params).toEqual([firstActivatedAt]);
      expect(repo.setDiscardedCount).toHaveBeenCalledWith(client, 2);
      expect(sqls[sqls.length - 1]).toMatch(/COMMIT/);
      expect(client.released).toBe(true);
    });

    it('discardedCount=0 cuando no habia PENDING externas previas', async () => {
      const firstActivatedAt = new Date('2026-10-22T12:00:00Z');
      const repo = {
        get: jest.fn().mockResolvedValue(null),
        tryInsertFirstActivation: jest.fn().mockResolvedValue({ firstActivatedAt }),
        setDiscardedCount: jest.fn().mockResolvedValue(undefined),
      };
      const client = makeTxClient(async (sql) => {
        if (/UPDATE emergencies/.test(sql)) return { rowCount: 0, rows: [] };
        return {};
      });
      const pool = { connect: jest.fn().mockResolvedValue(client) };

      const result = await activateAndDiscardStalePending({ pool, repo });

      expect(result.firstActivation).toBe(true);
      expect(result.discardedCount).toBe(0);
      expect(result.discardedIds).toEqual([]);
      expect(repo.setDiscardedCount).toHaveBeenCalledWith(client, 0);
    });
  });

  describe('carrera entre pods (otro gano el candado)', () => {
    it('rollbackea y devuelve el valor consolidado', async () => {
      const otherDate = new Date('2026-10-22T12:00:00Z');
      const repo = {
        get: jest.fn()
          .mockResolvedValueOnce(null) // fast-path check inicial
          .mockResolvedValueOnce({ firstActivatedAt: otherDate, discardedCount: 5 }),
        tryInsertFirstActivation: jest.fn().mockResolvedValue(null),
        setDiscardedCount: jest.fn(),
      };
      const client = makeTxClient(async () => ({}));
      const pool = { connect: jest.fn().mockResolvedValue(client) };

      const result = await activateAndDiscardStalePending({ pool, repo });

      expect(result).toEqual({
        firstActivation: false,
        firstActivatedAt: otherDate,
        discardedCount: 5,
        discardedIds: [],
      });
      expect(client.calls.map((c) => c.sql)).toEqual(['BEGIN', 'ROLLBACK']);
      expect(repo.setDiscardedCount).not.toHaveBeenCalled();
      expect(client.released).toBe(true);
    });

    it('rollback con get() devolviendo null sigue siendo seguro (no explota)', async () => {
      const repo = {
        get: jest.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        tryInsertFirstActivation: jest.fn().mockResolvedValue(null),
        setDiscardedCount: jest.fn(),
      };
      const client = makeTxClient(async () => ({}));
      const pool = { connect: jest.fn().mockResolvedValue(client) };

      const result = await activateAndDiscardStalePending({ pool, repo });

      expect(result).toEqual({
        firstActivation: false,
        firstActivatedAt: null,
        discardedCount: 0,
        discardedIds: [],
      });
    });
  });

  describe('errores', () => {
    it('rollbackea y libera el client si la insercion lanza', async () => {
      const repo = {
        get: jest.fn().mockResolvedValue(null),
        tryInsertFirstActivation: jest.fn().mockRejectedValue(new Error('db down')),
        setDiscardedCount: jest.fn(),
      };
      const client = makeTxClient(async () => ({}));
      const pool = { connect: jest.fn().mockResolvedValue(client) };

      await expect(activateAndDiscardStalePending({ pool, repo })).rejects.toThrow('db down');
      expect(client.calls.map((c) => c.sql)).toEqual(['BEGIN', 'ROLLBACK']);
      expect(client.released).toBe(true);
    });

    it('rollbackea y libera si el UPDATE emergencies falla', async () => {
      const firstActivatedAt = new Date();
      const repo = {
        get: jest.fn().mockResolvedValue(null),
        tryInsertFirstActivation: jest.fn().mockResolvedValue({ firstActivatedAt }),
        setDiscardedCount: jest.fn(),
      };
      const client = makeTxClient(async (sql) => {
        if (/UPDATE emergencies/.test(sql)) throw new Error('deadlock');
        return {};
      });
      const pool = { connect: jest.fn().mockResolvedValue(client) };

      await expect(activateAndDiscardStalePending({ pool, repo })).rejects.toThrow('deadlock');
      const sqls = client.calls.map((c) => c.sql);
      expect(sqls).toContain('BEGIN');
      expect(sqls).toContain('ROLLBACK');
      expect(repo.setDiscardedCount).not.toHaveBeenCalled();
      expect(client.released).toBe(true);
    });
  });
});
