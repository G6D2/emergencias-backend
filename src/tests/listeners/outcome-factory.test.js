const { OutcomeFactory } = require('../../listeners/outcome-factory');

function buildPool() {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  return { client, pool: { connect: jest.fn().mockResolvedValue(client) } };
}

const queries = (client) => client.query.mock.calls.map(([sql]) => sql);

describe('OutcomeFactory', () => {
  it('requiere un pool', () => {
    expect(() => new OutcomeFactory()).toThrow(/pool/);
  });

  describe('register', () => {
    it('rechaza un type vacio y un handler que no es funcion', () => {
      const factory = new OutcomeFactory(buildPool().pool);
      expect(() => factory.register('', jest.fn())).toThrow(/requiere un type/);
      expect(() => factory.register('A', 'no-funcion')).toThrow(/debe ser una funcion/);
    });

    it('rechaza dos handlers para el mismo type', () => {
      const factory = new OutcomeFactory(buildPool().pool).register('A', jest.fn());
      expect(() => factory.register('A', jest.fn())).toThrow(/Ya hay un handler registrado para A/);
    });
  });

  describe('process', () => {
    it('sin resultados no abre una transaccion', async () => {
      const { pool } = buildPool();
      await new OutcomeFactory(pool).process([]);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('ejecuta los handlers en orden, en una transaccion y con el mismo client', async () => {
      const { pool, client } = buildPool();
      const order = [];
      const primero = jest.fn(async () => order.push('primero'));
      const segundo = jest.fn(async () => order.push('segundo'));
      const factory = new OutcomeFactory(pool).register('A', primero).register('B', segundo);
      const context = { metadata: { eventId: 'e1' }, data: {} };

      await factory.process([{ type: 'A', payload: { a: 1 } }, { type: 'B', payload: { b: 2 } }], context);

      expect(order).toEqual(['primero', 'segundo']);
      expect(primero).toHaveBeenCalledWith(client, { a: 1 }, context);
      expect(segundo).toHaveBeenCalledWith(client, { b: 2 }, context);
      expect(queries(client)).toEqual(['BEGIN', 'COMMIT']);
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('un type sin handler falla antes de abrir la transaccion y no ejecuta nada', async () => {
      const { pool } = buildPool();
      const handler = jest.fn();
      const factory = new OutcomeFactory(pool).register('A', handler);

      await expect(factory.process([{ type: 'A' }, { type: 'Desconocido' }])).rejects.toThrow(
        /No hay un handler registrado para Desconocido/
      );

      expect(handler).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('si un handler falla hace ROLLBACK, no ejecuta los siguientes y propaga el error', async () => {
      const { pool, client } = buildPool();
      const siguiente = jest.fn();
      const factory = new OutcomeFactory(pool)
        .register('A', jest.fn().mockResolvedValue(undefined))
        .register('B', jest.fn().mockRejectedValue(new Error('boom')))
        .register('C', siguiente);

      await expect(factory.process([{ type: 'A' }, { type: 'B' }, { type: 'C' }])).rejects.toThrow('boom');

      expect(queries(client)).toEqual(['BEGIN', 'ROLLBACK']);
      expect(siguiente).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });
});
