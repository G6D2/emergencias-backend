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
        status: 'PROCESSED',
        discardReason: null,
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

  describe('markDiscarded', () => {
    it('registra el descarte con su motivo', async () => {
      const eventId = '00000000-0000-0000-0000-000000000005';
      await expect(repo.markDiscarded(null, { eventId, source: 'grupo7', eventType: 'T', reason: 'payload invalido' }))
        .resolves.toBe(true);

      expect(await repo.findById(eventId)).toMatchObject({
        eventId,
        status: 'DISCARDED',
        discardReason: 'payload invalido',
      });
    });

    it('no pisa un evento ya registrado', async () => {
      const eventId = '00000000-0000-0000-0000-000000000006';
      await repo.tryMarkProcessed(null, { eventId, source: 'src', eventType: 'T' });
      await expect(repo.markDiscarded(null, { eventId, source: 'src', eventType: 'T', reason: 'x' })).resolves.toBe(false);
      expect((await repo.findById(eventId)).status).toBe('PROCESSED');
    });

    it('exige eventId y motivo', async () => {
      await expect(repo.markDiscarded(null, { source: 's', eventType: 'T', reason: 'x' })).rejects.toThrow(/eventId/);
      await expect(repo.markDiscarded(null, { eventId: '00000000-0000-0000-0000-000000000007', source: 's', eventType: 'T' }))
        .rejects.toThrow(/reason/);
    });
  });

  describe('findById', () => {
    it('retorna null para un eventId inexistente', async () => {
      const row = await repo.findById('00000000-0000-0000-0000-000000000099');
      expect(row).toBeNull();
    });
  });
});
