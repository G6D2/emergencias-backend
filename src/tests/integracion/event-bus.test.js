const { EventBus } = require('../../integracion/event-bus');

describe('EventBus', () => {
  const makeKafkaStub = () => ({
    publishEvent: jest.fn().mockResolvedValue(true),
  });

  const ORIGINAL_ENV = process.env.KAFKA_CONSUMER_ENABLED;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.KAFKA_CONSUMER_ENABLED;
    else process.env.KAFKA_CONSUMER_ENABLED = ORIGINAL_ENV;
  });

  it('consumer deshabilitado por default (sin env, sin option)', () => {
    delete process.env.KAFKA_CONSUMER_ENABLED;
    const bus = new EventBus(makeKafkaStub());
    expect(bus.isConsumerEnabled()).toBe(false);
  });

  it('consumer habilitado via env KAFKA_CONSUMER_ENABLED=true', () => {
    process.env.KAFKA_CONSUMER_ENABLED = 'true';
    const bus = new EventBus(makeKafkaStub());
    expect(bus.isConsumerEnabled()).toBe(true);
  });

  it('options.consumerEnabled tiene prioridad sobre env', () => {
    process.env.KAFKA_CONSUMER_ENABLED = 'true';
    expect(new EventBus(makeKafkaStub(), { consumerEnabled: false }).isConsumerEnabled()).toBe(false);
    expect(new EventBus(makeKafkaStub(), { consumerEnabled: true }).isConsumerEnabled()).toBe(true);
  });

  it('publish delega a kafkaService.publishEvent', async () => {
    const kafka = makeKafkaStub();
    const bus = new EventBus(kafka);
    await bus.publish('topic.X', { a: 1 });
    expect(kafka.publishEvent).toHaveBeenCalledWith('topic.X', { a: 1 });
  });

  it('subscribe registra la suscripcion y permite listSubscriptions', () => {
    const bus = new EventBus(makeKafkaStub());
    const handler = jest.fn();
    bus.subscribe('topic.A', handler, { groupId: 'g1' });
    bus.subscribe('topic.B', handler);
    expect(bus.listSubscriptions()).toEqual([
      { topic: 'topic.A', groupId: 'g1' },
      { topic: 'topic.B', groupId: undefined },
    ]);
  });

  it('subscribe valida topic (string no vacio)', () => {
    const bus = new EventBus(makeKafkaStub());
    expect(() => bus.subscribe('', jest.fn())).toThrow(/topic/);
    expect(() => bus.subscribe(null, jest.fn())).toThrow(/topic/);
  });

  it('subscribe valida handler (function)', () => {
    const bus = new EventBus(makeKafkaStub());
    expect(() => bus.subscribe('topic.X', null)).toThrow(/handler/);
    expect(() => bus.subscribe('topic.X', 'no-funcion')).toThrow(/handler/);
  });

  it('startConsumers devuelve false y no se conecta cuando el consumer esta deshabilitado', async () => {
    const bus = new EventBus(makeKafkaStub(), { consumerEnabled: false });
    await expect(bus.startConsumers()).resolves.toBe(false);
  });

  it('startConsumers aun no implementado (PR 1 scaffold) devuelve false con warn aunque este habilitado', async () => {
    const bus = new EventBus(makeKafkaStub(), { consumerEnabled: true });
    await expect(bus.startConsumers()).resolves.toBe(false);
  });

  it('stopConsumers resuelve sin efectos (stub)', async () => {
    const bus = new EventBus(makeKafkaStub());
    await expect(bus.stopConsumers()).resolves.toBeUndefined();
  });
});
