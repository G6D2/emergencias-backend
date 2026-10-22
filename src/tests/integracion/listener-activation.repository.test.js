const { ListenerActivationRepository } = require('../../repositories/listener-activation.repository');

describe('ListenerActivationRepository', () => {
  const makePool = (impl) => ({ query: jest.fn().mockImplementation(impl) });

  describe('get()', () => {
    it('devuelve null si todavia no hay fila', async () => {
      const pool = makePool(async () => ({ rows: [] }));
      const repo = new ListenerActivationRepository(pool);
      await expect(repo.get()).resolves.toBeNull();
    });

    it('mapea first_activated_at y discarded_count', async () => {
      const date = new Date('2026-10-22T12:00:00Z');
      const pool = makePool(async () => ({
        rows: [{ first_activated_at: date, discarded_count: 3 }],
      }));
      const repo = new ListenerActivationRepository(pool);
      await expect(repo.get()).resolves.toEqual({
        firstActivatedAt: date,
        discardedCount: 3,
      });
    });

    it('usa el executor pasado por parametro si se da', async () => {
      const executor = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const pool = makePool(async () => { throw new Error('no deberia llamar al pool'); });
      const repo = new ListenerActivationRepository(pool);
      await repo.get(executor);
      expect(executor.query).toHaveBeenCalledTimes(1);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('tryInsertFirstActivation()', () => {
    it('devuelve firstActivatedAt cuando rowCount=1 (gano el candado)', async () => {
      const date = new Date('2026-10-22T12:00:00Z');
      const pool = makePool(async () => ({
        rowCount: 1,
        rows: [{ first_activated_at: date }],
      }));
      const repo = new ListenerActivationRepository(pool);
      await expect(repo.tryInsertFirstActivation()).resolves.toEqual({ firstActivatedAt: date });
    });

    it('devuelve null cuando rowCount=0 (otro pod ya inserto)', async () => {
      const pool = makePool(async () => ({ rowCount: 0, rows: [] }));
      const repo = new ListenerActivationRepository(pool);
      await expect(repo.tryInsertFirstActivation()).resolves.toBeNull();
    });

    it('ejecuta sobre el executor cuando corre dentro de una transaccion', async () => {
      const executor = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
      const pool = makePool(async () => { throw new Error('no deberia tocar el pool'); });
      const repo = new ListenerActivationRepository(pool);
      await repo.tryInsertFirstActivation(executor);
      expect(executor.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('setDiscardedCount()', () => {
    it('ejecuta UPDATE con la cantidad', async () => {
      const pool = makePool(async () => ({ rowCount: 1 }));
      const repo = new ListenerActivationRepository(pool);
      await repo.setDiscardedCount(null, 42);
      expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/UPDATE listener_activation/), [42]);
    });
  });
});
