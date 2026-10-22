const { Listener } = require('../../integracion/listener');
const { MapperRegistry } = require('../../integracion/mapper-registry');

describe('Listener', () => {
  const makeBusStub = () => ({
    subscribe: jest.fn().mockReturnThis(),
    startConsumers: jest.fn().mockResolvedValue(true),
    stopConsumers: jest.fn().mockResolvedValue(undefined),
  });

  const makeClientStub = () => ({
    query: jest.fn().mockResolvedValue({ rowCount: 1 }),
    release: jest.fn(),
  });

  const makePoolStub = (client) => ({
    connect: jest.fn().mockResolvedValue(client),
  });

  const makeRepoStub = (tryMarkResult = true) => ({
    tryMarkProcessed: jest.fn().mockResolvedValue(tryMarkResult),
  });

  it('start registra una subscripcion por topico y arranca el bus', async () => {
    const bus = makeBusStub();
    const listener = new Listener(bus, new MapperRegistry(), {
      topics: ['com.citypass.turismo.EventoComunitarioPublicado', 'com.citypass.turismo.EventoCancelado'],
      groupId: 'emergencias-test',
    });

    await listener.start();

    expect(bus.subscribe).toHaveBeenCalledTimes(2);
    expect(bus.subscribe.mock.calls[0][0]).toBe('com.citypass.turismo.EventoComunitarioPublicado');
    expect(bus.subscribe.mock.calls[0][2]).toEqual({ groupId: 'emergencias-test' });
    expect(bus.startConsumers).toHaveBeenCalled();
  });

  it('start sin topics no suscribe pero igual intenta arrancar el bus', async () => {
    const bus = makeBusStub();
    const listener = new Listener(bus, new MapperRegistry());
    await listener.start();
    expect(bus.subscribe).not.toHaveBeenCalled();
    expect(bus.startConsumers).toHaveBeenCalled();
  });

  it('stop delega al bus', async () => {
    const bus = makeBusStub();
    const listener = new Listener(bus, new MapperRegistry());
    await listener.stop();
    expect(bus.stopConsumers).toHaveBeenCalled();
  });

  it('groupId usa env KAFKA_GROUP_ID como fallback', () => {
    const prev = process.env.KAFKA_GROUP_ID;
    process.env.KAFKA_GROUP_ID = 'from-env';
    try {
      const listener = new Listener(makeBusStub(), new MapperRegistry());
      expect(listener.groupId).toBe('from-env');
    } finally {
      if (prev === undefined) delete process.env.KAFKA_GROUP_ID;
      else process.env.KAFKA_GROUP_ID = prev;
    }
  });

  describe('handleEvent', () => {
    it('descarta cuando no hay mapper registrado', async () => {
      const listener = new Listener(makeBusStub(), new MapperRegistry());
      const result = await listener.handleEvent('com.citypass.turismo.NoExiste', {
        metadata: { eventId: 'evt-1' },
        data: {},
      });
      expect(result).toEqual({ discarded: true, reason: 'no-mapper' });
    });

    it('descarta cuando falta metadata.eventId', async () => {
      const registry = new MapperRegistry();
      registry.register('EventoComunitarioPublicado', jest.fn());
      const listener = new Listener(makeBusStub(), registry);
      const result = await listener.handleEvent(
        'com.citypass.turismo.EventoComunitarioPublicado',
        { metadata: {}, data: {} }
      );
      expect(result).toEqual({ discarded: true, reason: 'missing-event-id' });
    });

    it('lanza si no se configuro pool o repo', async () => {
      const registry = new MapperRegistry();
      registry.register('X', jest.fn());
      const listener = new Listener(makeBusStub(), registry);
      await expect(
        listener.handleEvent('ns.X', { metadata: { eventId: 'e1' }, data: {} })
      ).rejects.toThrow(/pool y eventosProcesadosRepo/);
    });

    it('procesa evento fresco: BEGIN, tryMarkProcessed, mapper, commands, COMMIT', async () => {
      const client = makeClientStub();
      const pool = makePoolStub(client);
      const repo = makeRepoStub(true);
      const registry = new MapperRegistry();

      const commandExecute = jest.fn().mockResolvedValue(undefined);
      const mapper = jest.fn().mockResolvedValue([{ execute: commandExecute }]);
      registry.register('EventoComunitarioPublicado', mapper);

      const listener = new Listener(makeBusStub(), registry, {
        pool,
        eventosProcesadosRepo: repo,
      });

      const message = {
        metadata: {
          eventId: 'evt-123',
          source: 'grupo6',
          eventType: 'com.citypass.turismo.EventoComunitarioPublicado',
        },
        data: { nombre: 'Feria' },
      };

      const result = await listener.handleEvent(
        'com.citypass.turismo.EventoComunitarioPublicado',
        message
      );

      expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(repo.tryMarkProcessed).toHaveBeenCalledWith(client, {
        eventId: 'evt-123',
        source: 'grupo6',
        eventType: 'com.citypass.turismo.EventoComunitarioPublicado',
        causationId: null,
      });
      expect(mapper).toHaveBeenCalledWith({ metadata: message.metadata, data: message.data });
      expect(commandExecute).toHaveBeenCalledWith({
        client,
        metadata: message.metadata,
        causationId: 'evt-123',
      });
      expect(client.query).toHaveBeenLastCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalled();
      expect(result).toEqual({ processed: true, commandCount: 1 });
    });

    it('descarta duplicados: ROLLBACK y no ejecuta mapper', async () => {
      const client = makeClientStub();
      const pool = makePoolStub(client);
      const repo = makeRepoStub(false);
      const registry = new MapperRegistry();
      const mapper = jest.fn();
      registry.register('X', mapper);

      const listener = new Listener(makeBusStub(), registry, {
        pool,
        eventosProcesadosRepo: repo,
      });

      const result = await listener.handleEvent('ns.X', {
        metadata: { eventId: 'evt-dup', source: 'ns', eventType: 'ns.X' },
        data: {},
      });

      expect(mapper).not.toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(result).toEqual({ discarded: true, reason: 'duplicate' });
    });

    it('mapper que devuelve undefined no ejecuta comandos y COMMIT igual', async () => {
      const client = makeClientStub();
      const pool = makePoolStub(client);
      const repo = makeRepoStub(true);
      const registry = new MapperRegistry();
      registry.register('X', jest.fn().mockResolvedValue(undefined));

      const listener = new Listener(makeBusStub(), registry, {
        pool,
        eventosProcesadosRepo: repo,
      });

      const result = await listener.handleEvent('ns.X', {
        metadata: { eventId: 'e1', source: 'ns', eventType: 'ns.X' },
        data: {},
      });

      expect(result).toEqual({ processed: true, commandCount: 0 });
      expect(client.query).toHaveBeenCalledWith('COMMIT');
    });

    it('comando invalido lanza y hace ROLLBACK', async () => {
      const client = makeClientStub();
      const pool = makePoolStub(client);
      const repo = makeRepoStub(true);
      const registry = new MapperRegistry();
      registry.register('X', jest.fn().mockResolvedValue([{ noExecute: true }]));

      const listener = new Listener(makeBusStub(), registry, {
        pool,
        eventosProcesadosRepo: repo,
      });

      await expect(
        listener.handleEvent('ns.X', {
          metadata: { eventId: 'e1', source: 'ns', eventType: 'ns.X' },
          data: {},
        })
      ).rejects.toThrow(/Comando invalido/);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    });

    it('error en comando: ROLLBACK y relanza (consumer NO debe commit offset)', async () => {
      const client = makeClientStub();
      const pool = makePoolStub(client);
      const repo = makeRepoStub(true);
      const registry = new MapperRegistry();
      const explode = jest.fn().mockRejectedValue(new Error('boom'));
      registry.register('X', jest.fn().mockResolvedValue([{ execute: explode }]));

      const listener = new Listener(makeBusStub(), registry, {
        pool,
        eventosProcesadosRepo: repo,
      });

      await expect(
        listener.handleEvent('ns.X', {
          metadata: { eventId: 'e1', source: 'ns', eventType: 'ns.X' },
          data: {},
        })
      ).rejects.toThrow('boom');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    });

    it('propaga metadata.causationId al tryMarkProcessed cuando el evento ya tiene cadena', async () => {
      const client = makeClientStub();
      const pool = makePoolStub(client);
      const repo = makeRepoStub(true);
      const registry = new MapperRegistry();
      registry.register('X', jest.fn().mockResolvedValue([]));

      const listener = new Listener(makeBusStub(), registry, {
        pool,
        eventosProcesadosRepo: repo,
      });

      await listener.handleEvent('ns.X', {
        metadata: { eventId: 'e2', source: 'ns', eventType: 'ns.X', causationId: 'parent-1' },
        data: {},
      });

      expect(repo.tryMarkProcessed).toHaveBeenCalledWith(client, expect.objectContaining({
        causationId: 'parent-1',
      }));
    });

    it('source default es "unknown" si no viene', async () => {
      const client = makeClientStub();
      const pool = makePoolStub(client);
      const repo = makeRepoStub(true);
      const registry = new MapperRegistry();
      registry.register('X', jest.fn().mockResolvedValue([]));

      const listener = new Listener(makeBusStub(), registry, { pool, eventosProcesadosRepo: repo });
      await listener.handleEvent('ns.X', { metadata: { eventId: 'e1' }, data: {} });

      expect(repo.tryMarkProcessed).toHaveBeenCalledWith(client, expect.objectContaining({
        source: 'unknown',
      }));
    });
  });
});
