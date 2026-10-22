const { Listener } = require('../../integracion/listener');
const { MapperRegistry } = require('../../integracion/mapper-registry');

describe('Listener', () => {
  const makeBusStub = () => ({
    subscribe: jest.fn().mockReturnThis(),
    startConsumers: jest.fn().mockResolvedValue(false),
    stopConsumers: jest.fn().mockResolvedValue(undefined),
  });

  it('start registra una subscripcion por topico y arranca el bus', async () => {
    const bus = makeBusStub();
    const registry = new MapperRegistry();
    const listener = new Listener(bus, registry, {
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

  it('handleEvent descarta cuando no hay mapper registrado', async () => {
    const listener = new Listener(makeBusStub(), new MapperRegistry());
    const result = await listener.handleEvent(
      'com.citypass.turismo.NoExiste',
      { data: {} }
    );
    expect(result).toEqual({ discarded: true, reason: 'no-mapper' });
  });

  it('handleEvent reporta mapper encontrado pero no lo ejecuta (scaffold PR 1)', async () => {
    const registry = new MapperRegistry();
    const mapper = jest.fn();
    registry.register('EventoComunitarioPublicado', mapper);

    const listener = new Listener(makeBusStub(), registry);
    const event = { data: { nombre: 'Feria' } };
    const result = await listener.handleEvent(
      'com.citypass.turismo.EventoComunitarioPublicado',
      event
    );

    expect(result).toEqual({ discarded: false, mapperFound: true, event });
    // En PR 1 el mapper NO se ejecuta todavia; eso llega en PR 2.
    expect(mapper).not.toHaveBeenCalled();
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
});
