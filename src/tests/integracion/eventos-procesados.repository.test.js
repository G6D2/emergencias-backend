const { EventosProcesadosRepository } = require('../../repositories/eventos-procesados.repository');

describe('EventosProcesadosRepository', () => {
  const makePool = () => ({ query: jest.fn() });
  const makeClient = () => ({ query: jest.fn() });

  describe('tryMarkProcessed', () => {
    it('devuelve true si INSERT inserto (rowCount 1)', async () => {
      const client = makeClient();
      client.query.mockResolvedValue({ rowCount: 1 });
      const repo = new EventosProcesadosRepository(makePool());

      const fresh = await repo.tryMarkProcessed(client, {
        eventId: 'e-1',
        source: 'grupo6',
        eventType: 'ns.X',
      });

      expect(fresh).toBe(true);
      expect(client.query.mock.calls[0][0]).toMatch(/INSERT INTO eventos_procesados/);
      expect(client.query.mock.calls[0][0]).toMatch(/ON CONFLICT.*DO NOTHING/i);
      expect(client.query.mock.calls[0][1]).toEqual(['e-1', 'grupo6', 'ns.X', null]);
    });

    it('devuelve false si ya existia (rowCount 0 por ON CONFLICT)', async () => {
      const client = makeClient();
      client.query.mockResolvedValue({ rowCount: 0 });
      const repo = new EventosProcesadosRepository(makePool());

      const fresh = await repo.tryMarkProcessed(client, {
        eventId: 'e-dup',
        source: 'grupo6',
        eventType: 'ns.X',
      });

      expect(fresh).toBe(false);
    });

    it('persiste causationId si se pasa', async () => {
      const client = makeClient();
      client.query.mockResolvedValue({ rowCount: 1 });
      const repo = new EventosProcesadosRepository(makePool());

      await repo.tryMarkProcessed(client, {
        eventId: 'e-1',
        source: 's',
        eventType: 't',
        causationId: 'parent-1',
      });

      expect(client.query.mock.calls[0][1]).toEqual(['e-1', 's', 't', 'parent-1']);
    });

    it('cae al pool si no se pasa executor', async () => {
      const pool = makePool();
      pool.query.mockResolvedValue({ rowCount: 1 });
      const repo = new EventosProcesadosRepository(pool);

      const fresh = await repo.tryMarkProcessed(null, {
        eventId: 'e-1',
        source: 's',
        eventType: 't',
      });

      expect(fresh).toBe(true);
      expect(pool.query).toHaveBeenCalled();
    });

    it('lanza si falta eventId', async () => {
      const repo = new EventosProcesadosRepository(makePool());
      await expect(repo.tryMarkProcessed(makeClient(), { source: 's', eventType: 't' }))
        .rejects.toThrow(/eventId/);
    });

    it('lanza si falta source', async () => {
      const repo = new EventosProcesadosRepository(makePool());
      await expect(repo.tryMarkProcessed(makeClient(), { eventId: 'e', eventType: 't' }))
        .rejects.toThrow(/source/);
    });

    it('lanza si falta eventType', async () => {
      const repo = new EventosProcesadosRepository(makePool());
      await expect(repo.tryMarkProcessed(makeClient(), { eventId: 'e', source: 's' }))
        .rejects.toThrow(/eventType/);
    });
  });

  describe('findById', () => {
    it('devuelve null si no existe', async () => {
      const pool = makePool();
      pool.query.mockResolvedValue({ rows: [] });
      const repo = new EventosProcesadosRepository(pool);
      await expect(repo.findById('nope')).resolves.toBeNull();
    });

    it('mapea las columnas a camelCase', async () => {
      const pool = makePool();
      const processedAt = new Date('2026-10-22T12:00:00Z');
      pool.query.mockResolvedValue({
        rows: [{
          event_id: 'e1',
          source: 's',
          event_type: 't',
          causation_id: 'c',
          processed_at: processedAt,
        }],
      });
      const repo = new EventosProcesadosRepository(pool);
      await expect(repo.findById('e1')).resolves.toEqual({
        eventId: 'e1',
        source: 's',
        eventType: 't',
        causationId: 'c',
        processedAt,
      });
    });
  });
});
