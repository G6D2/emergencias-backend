const { getPool } = require('../db/pool');
const { EventosProcesadosRepository } = require('../repositories/eventos-procesados.repository');

let pool;
let repo;

beforeAll(() => {
  pool = getPool();
  repo = new EventosProcesadosRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM eventos_procesados');
});

describe('EventosProcesadosRepository (integration)', () => {
  describe('tryMarkProcessed', () => {
    it('retorna true y persiste cuando el eventId es nuevo', async () => {
      const eventId = '00000000-0000-0000-0000-000000000001';
      const fresh = await repo.tryMarkProcessed(null, {
        eventId,
        source: 'com.espacios',
        eventType: 'EventoComunitarioPublicado',
      });

      expect(fresh).toBe(true);
      const row = await repo.findById(eventId);
      expect(row).toMatchObject({
        eventId,
        source: 'com.espacios',
        eventType: 'EventoComunitarioPublicado',
        causationId: null,
      });
    });

    it('retorna false sin lanzar cuando el eventId ya existe (duplicado)', async () => {
      const eventId = '00000000-0000-0000-0000-000000000002';
      await repo.tryMarkProcessed(null, { eventId, source: 'src', eventType: 'T' });

      const secondTime = await repo.tryMarkProcessed(null, { eventId, source: 'src', eventType: 'T' });
      expect(secondTime).toBe(false);
    });

    it('persiste causationId cuando viene', async () => {
      const eventId = '00000000-0000-0000-0000-000000000003';
      await repo.tryMarkProcessed(null, {
        eventId,
        source: 'src',
        eventType: 'T',
        causationId: '00000000-0000-0000-0000-000000000099',
      });

      const row = await repo.findById(eventId);
      expect(row.causationId).toBe('00000000-0000-0000-0000-000000000099');
    });

    it('corre dentro de una transaccion existente: ROLLBACK revierte el insert', async () => {
      const eventId = '00000000-0000-0000-0000-000000000004';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await repo.tryMarkProcessed(client, { eventId, source: 'src', eventType: 'T' });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const row = await repo.findById(eventId);
      expect(row).toBeNull();
    });
  });

  describe('findById', () => {
    it('retorna null para un eventId inexistente', async () => {
      const row = await repo.findById('00000000-0000-0000-0000-000000000099');
      expect(row).toBeNull();
    });
  });
});
