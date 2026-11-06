const { OutcomeFactory } = require('../../listeners/outcome-factory');
const { isTransientError } = require('../../listeners/error-classifier');

function buildPool() {
  const client = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }), release: jest.fn() };
  return { client, pool: { connect: jest.fn().mockResolvedValue(client) } };
}

function buildDedupRepo(fresh = true) {
  return { tryMarkProcessed: jest.fn().mockResolvedValue(fresh) };
}

const queries = (client) => client.query.mock.calls.map(([sql]) => sql);

const EV1 = 'a1000000-0000-4000-8000-000000000001';
const EV_DUP = 'a1000000-0000-4000-8000-000000000002';
const EV_NOOPS = 'a1000000-0000-4000-8000-000000000003';
const CAUSATION = 'c1000000-0000-4000-8000-000000000001';

describe('OutcomeFactory', () => {
  it('requiere un pool', () => {
    expect(() => new OutcomeFactory()).toThrow(/pool/);
  });

  describe('register', () => {
    it('rechaza type vacio y handler que no es funcion', () => {
      const f = new OutcomeFactory(buildPool().pool);
      expect(() => f.register('', jest.fn())).toThrow(/requiere un type/);
      expect(() => f.register('A', 'no-fn')).toThrow(/debe ser una funcion/);
    });

    it('rechaza dos handlers para el mismo type', () => {
      const f = new OutcomeFactory(buildPool().pool).register('A', jest.fn());
      expect(() => f.register('A', jest.fn())).toThrow(/Ya hay un handler registrado para A/);
    });

    it('register devuelve la factory para encadenar', () => {
      const f = new OutcomeFactory(buildPool().pool);
      expect(f.register('A', jest.fn())).toBe(f);
    });
  });

  describe('process — sin dedup', () => {
    it('sin outcomes no abre transaccion', async () => {
      const { pool } = buildPool();
      await new OutcomeFactory(pool).process([]);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('ejecuta handlers en orden en una transaccion con el mismo client', async () => {
      const { pool, client } = buildPool();
      const order = [];
      const a = jest.fn(async () => order.push('a'));
      const b = jest.fn(async () => order.push('b'));
      const f = new OutcomeFactory(pool).register('A', a).register('B', b);
      const context = { metadata: { eventId: EV1 }, data: {} };

      await f.process([{ type: 'A', payload: { x: 1 } }, { type: 'B', payload: { y: 2 } }], context);

      expect(order).toEqual(['a', 'b']);
      expect(a).toHaveBeenCalledWith(client, { x: 1 }, context);
      expect(b).toHaveBeenCalledWith(client, { y: 2 }, context);
      expect(queries(client)).toEqual(['BEGIN', 'COMMIT']);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('type sin handler falla antes de abrir transaccion', async () => {
      const { pool } = buildPool();
      const f = new OutcomeFactory(pool).register('A', jest.fn());

      await expect(f.process([{ type: 'A' }, { type: 'Desconocido' }]))
        .rejects.toThrow(/No hay un handler registrado para Desconocido/);

      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('error en handler hace ROLLBACK y propaga', async () => {
      const { pool, client } = buildPool();
      const siguiente = jest.fn();
      const f = new OutcomeFactory(pool)
        .register('A', jest.fn().mockResolvedValue(undefined))
        .register('B', jest.fn().mockRejectedValue(new Error('boom')))
        .register('C', siguiente);

      await expect(f.process([{ type: 'A' }, { type: 'B' }, { type: 'C' }])).rejects.toThrow('boom');

      expect(queries(client)).toEqual(['BEGIN', 'ROLLBACK']);
      expect(siguiente).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('process — con dedup', () => {
    it('evento fresco: tryMarkProcessed dentro de la tx, luego ejecuta handlers', async () => {
      const { pool, client } = buildPool();
      const dedupRepo = buildDedupRepo(true);
      const handler = jest.fn().mockResolvedValue(undefined);
      const f = new OutcomeFactory(pool, { dedupRepo }).register('A', handler);
      const context = { metadata: { eventId: EV1, source: 'com.espacios', eventType: 'EventoComunitarioPublicado' }, data: {} };

      await f.process([{ type: 'A', payload: {} }], context);

      expect(dedupRepo.tryMarkProcessed).toHaveBeenCalledWith(client, {
        eventId: EV1,
        source: 'com.espacios',
        eventType: 'EventoComunitarioPublicado',
        causationId: null,
      });
      expect(handler).toHaveBeenCalled();
      expect(queries(client)).toEqual(['BEGIN', 'COMMIT']);
    });

    it('evento duplicado: ROLLBACK sin ejecutar handlers', async () => {
      const { pool, client } = buildPool();
      const dedupRepo = buildDedupRepo(false);
      const handler = jest.fn();
      const f = new OutcomeFactory(pool, { dedupRepo }).register('A', handler);
      const context = { metadata: { eventId: EV_DUP, source: 'src', eventType: 'T' }, data: {} };

      await f.process([{ type: 'A', payload: {} }], context);

      expect(handler).not.toHaveBeenCalled();
      expect(queries(client)).toEqual(['BEGIN', 'ROLLBACK']);
    });

    it('sin eventId en metadata no llama al dedupRepo', async () => {
      const { pool } = buildPool();
      const dedupRepo = buildDedupRepo(true);
      const f = new OutcomeFactory(pool, { dedupRepo }).register('A', jest.fn());

      await f.process([{ type: 'A', payload: {} }], { metadata: {}, data: {} });

      expect(dedupRepo.tryMarkProcessed).not.toHaveBeenCalled();
    });

    it('sin outcomes pero con dedup y eventId: marca procesado aunque no haya handlers', async () => {
      const { pool, client } = buildPool();
      const dedupRepo = buildDedupRepo(true);
      const f = new OutcomeFactory(pool, { dedupRepo });
      const context = { metadata: { eventId: EV_NOOPS, source: 'src', eventType: 'T' }, data: {} };

      await f.process([], context);

      expect(dedupRepo.tryMarkProcessed).toHaveBeenCalledWith(client, expect.objectContaining({ eventId: EV_NOOPS }));
      expect(queries(client)).toEqual(['BEGIN', 'COMMIT']);
    });

    it('causationId se pasa al dedupRepo si esta en metadata', async () => {
      const { pool, client } = buildPool();
      const dedupRepo = buildDedupRepo(true);
      const f = new OutcomeFactory(pool, { dedupRepo });
      const context = { metadata: { eventId: EV1, source: 's', eventType: 't', causationId: CAUSATION }, data: {} };

      await f.process([], context);

      expect(dedupRepo.tryMarkProcessed).toHaveBeenCalledWith(client, expect.objectContaining({ causationId: CAUSATION }));
    });

    it('un causationId que no es UUID se guarda como null en vez de romper el INSERT', async () => {
      const { pool, client } = buildPool();
      const dedupRepo = buildDedupRepo(true);
      const f = new OutcomeFactory(pool, { dedupRepo });
      const context = { metadata: { eventId: EV1, source: 's', eventType: 't', causationId: 'evento-ev-1500' }, data: {} };

      await f.process([], context);

      expect(dedupRepo.tryMarkProcessed).toHaveBeenCalledWith(client, expect.objectContaining({ causationId: null }));
    });

    it.each([
      ['texto con "timeout"', 'timeout-123'],
      ['número', 42],
      ['uuid sin guiones', 'a1000000000040008000000000000001'],
    ])('un eventId que no es UUID (%s) es permanente y no abre transacción', async (_, eventId) => {
      const { pool } = buildPool();
      const dedupRepo = buildDedupRepo(true);
      const handler = jest.fn();
      const f = new OutcomeFactory(pool, { dedupRepo }).register('A', handler);

      const error = await f.process([{ type: 'A', payload: {} }], { metadata: { eventId }, data: {} })
        .catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/no es un UUID/);
      expect(isTransientError(error)).toBe(false);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(dedupRepo.tryMarkProcessed).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('process — errores de conexión', () => {
    it('si no hay conexión (pool.connect falla), el error queda transitorio', async () => {
      const pool = { connect: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')) };
      const f = new OutcomeFactory(pool).register('A', jest.fn());

      const error = await f.process([{ type: 'A', payload: {} }]).catch((e) => e);

      expect(error.message).toBe('timeout exceeded when trying to connect');
      expect(isTransientError(error)).toBe(true);
    });

    it('si el ROLLBACK también falla, la conexión se cortó: transitorio y el client se descarta del pool', async () => {
      const { pool, client } = buildPool();
      const rollbackError = new Error('Client has encountered a connection error and is not queryable');
      client.query.mockImplementation(async (sql) => {
        if (sql === 'ROLLBACK') throw rollbackError;
        return { rowCount: 0, rows: [] };
      });
      const f = new OutcomeFactory(pool)
        .register('A', jest.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')));

      const error = await f.process([{ type: 'A', payload: {} }]).catch((e) => e);

      expect(error.message).toBe('Connection terminated unexpectedly');
      expect(isTransientError(error)).toBe(true);
      expect(client.release).toHaveBeenCalledWith(rollbackError);
    });

    it('un error del handler con la conexión sana se clasifica por su código (22P02 permanente)', async () => {
      const { pool, client } = buildPool();
      const f = new OutcomeFactory(pool)
        .register('A', jest.fn().mockRejectedValue(Object.assign(
          new Error('invalid input syntax for type uuid: "timeout"'),
          { code: '22P02' }
        )));

      const error = await f.process([{ type: 'A', payload: {} }]).catch((e) => e);

      expect(isTransientError(error)).toBe(false);
      expect(client.release).toHaveBeenCalledWith(undefined);
    });
  });

  describe('recordDiscard', () => {
    it('registra el descarte con el motivo, fuera de la transacción (sin BEGIN)', async () => {
      const { pool, client } = buildPool();
      const dedupRepo = { markDiscarded: jest.fn().mockResolvedValue(true) };
      const f = new OutcomeFactory(pool, { dedupRepo });

      await expect(f.recordDiscard(
        { metadata: { eventId: EV1, source: 'grupo6', eventType: 'com.citypass.espacios.EventoCancelado' } },
        'payload invalido'
      )).resolves.toBe(true);

      expect(dedupRepo.markDiscarded).toHaveBeenCalledWith(client, {
        eventId: EV1,
        source: 'grupo6',
        eventType: 'com.citypass.espacios.EventoCancelado',
        causationId: null,
        reason: 'payload invalido',
      });
      expect(queries(client)).toEqual([]);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('sin dedupRepo, sin eventId o con un eventId que no es UUID no registra nada', async () => {
      const { pool } = buildPool();
      await expect(new OutcomeFactory(pool).recordDiscard({ metadata: { eventId: EV1 } }, 'x')).resolves.toBe(false);
      const dedupRepo = { markDiscarded: jest.fn() };
      await expect(new OutcomeFactory(pool, { dedupRepo }).recordDiscard({ metadata: {} }, 'x')).resolves.toBe(false);
      await expect(new OutcomeFactory(pool, { dedupRepo }).recordDiscard({ metadata: { eventId: 'timeout-1' } }, 'x'))
        .resolves.toBe(false);
      expect(dedupRepo.markDiscarded).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('si no hay conexión para registrar el descarte, el error queda transitorio (se reentrega)', async () => {
      const pool = { connect: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')) };
      const dedupRepo = { markDiscarded: jest.fn() };

      const error = await new OutcomeFactory(pool, { dedupRepo })
        .recordDiscard({ metadata: { eventId: EV1 } }, 'x')
        .catch((e) => e);

      expect(isTransientError(error)).toBe(true);
      expect(dedupRepo.markDiscarded).not.toHaveBeenCalled();
    });

    it('recorta motivos largos y completa los campos faltantes', async () => {
      const dedupRepo = { markDiscarded: jest.fn().mockResolvedValue(true) };
      await new OutcomeFactory(buildPool().pool, { dedupRepo }).recordDiscard({ metadata: { eventId: EV1 } }, 'x'.repeat(900));
      const input = dedupRepo.markDiscarded.mock.calls[0][1];
      expect(input.reason).toHaveLength(500);
      expect(input.source).toBe('unknown');
      expect(input.eventType).toBe('unknown');
    });
  });
});
