const { OutcomeFactory } = require('../../listeners/outcome-factory');

function buildPool() {
  const client = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }), release: jest.fn() };
  return { client, pool: { connect: jest.fn().mockResolvedValue(client) } };
}

function buildDedupRepo(fresh = true) {
  return { tryMarkProcessed: jest.fn().mockResolvedValue(fresh) };
}

const queries = (client) => client.query.mock.calls.map(([sql]) => sql);

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
      const context = { metadata: { eventId: 'e1' }, data: {} };

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
      const context = { metadata: { eventId: 'ev-1', source: 'com.espacios', eventType: 'EventoComunitarioPublicado' }, data: {} };

      await f.process([{ type: 'A', payload: {} }], context);

      expect(dedupRepo.tryMarkProcessed).toHaveBeenCalledWith(client, {
        eventId: 'ev-1',
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
      const context = { metadata: { eventId: 'ev-dup', source: 'src', eventType: 'T' }, data: {} };

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
      const context = { metadata: { eventId: 'ev-noops', source: 'src', eventType: 'T' }, data: {} };

      await f.process([], context);

      expect(dedupRepo.tryMarkProcessed).toHaveBeenCalledWith(client, expect.objectContaining({ eventId: 'ev-noops' }));
      expect(queries(client)).toEqual(['BEGIN', 'COMMIT']);
    });

    it('causationId se pasa al dedupRepo si esta en metadata', async () => {
      const { pool, client } = buildPool();
      const dedupRepo = buildDedupRepo(true);
      const f = new OutcomeFactory(pool, { dedupRepo });
      const context = { metadata: { eventId: 'ev', source: 's', eventType: 't', causationId: 'cid-1' }, data: {} };

      await f.process([], context);

      expect(dedupRepo.tryMarkProcessed).toHaveBeenCalledWith(client, expect.objectContaining({ causationId: 'cid-1' }));
    });
  });
});
