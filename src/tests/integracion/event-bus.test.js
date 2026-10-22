const mockConsumer = {
  connect: jest.fn(),
  subscribe: jest.fn(),
  run: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: jest.fn(() => mockConsumer),
  })),
}));

const { EventBus, defaultConsumerKafkaFactory } = require('../../integracion/event-bus');
const { Kafka } = require('kafkajs');

describe('EventBus', () => {
  const ORIGINAL_ENV = { ...process.env };

  const makeKafkaServiceStub = () => ({
    publishEvent: jest.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConsumer.run.mockImplementation(async () => {});
    mockConsumer.connect.mockResolvedValue(undefined);
    mockConsumer.subscribe.mockResolvedValue(undefined);
    mockConsumer.disconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('configuracion', () => {
    it('consumer deshabilitado por default (sin env, sin option)', () => {
      delete process.env.KAFKA_CONSUMER_ENABLED;
      const bus = new EventBus(makeKafkaServiceStub());
      expect(bus.isConsumerEnabled()).toBe(false);
    });

    it('consumer habilitado via env KAFKA_CONSUMER_ENABLED=true', () => {
      process.env.KAFKA_CONSUMER_ENABLED = 'true';
      const bus = new EventBus(makeKafkaServiceStub());
      expect(bus.isConsumerEnabled()).toBe(true);
    });

    it('options.consumerEnabled tiene prioridad sobre env', () => {
      process.env.KAFKA_CONSUMER_ENABLED = 'true';
      expect(new EventBus(makeKafkaServiceStub(), { consumerEnabled: false }).isConsumerEnabled()).toBe(false);
      expect(new EventBus(makeKafkaServiceStub(), { consumerEnabled: true }).isConsumerEnabled()).toBe(true);
    });
  });

  describe('publish', () => {
    it('delega a kafkaService.publishEvent', async () => {
      const kafka = makeKafkaServiceStub();
      const bus = new EventBus(kafka);
      await bus.publish('topic.X', { a: 1 });
      expect(kafka.publishEvent).toHaveBeenCalledWith('topic.X', { a: 1 });
    });
  });

  describe('subscribe', () => {
    it('registra la suscripcion y permite listSubscriptions', () => {
      const bus = new EventBus(makeKafkaServiceStub());
      const handler = jest.fn();
      bus.subscribe('topic.A', handler, { groupId: 'g1' });
      bus.subscribe('topic.B', handler);
      expect(bus.listSubscriptions()).toEqual([
        { topic: 'topic.A', groupId: 'g1' },
        { topic: 'topic.B', groupId: undefined },
      ]);
    });

    it('valida topic (string no vacio)', () => {
      const bus = new EventBus(makeKafkaServiceStub());
      expect(() => bus.subscribe('', jest.fn())).toThrow(/topic/);
      expect(() => bus.subscribe(null, jest.fn())).toThrow(/topic/);
    });

    it('valida handler (function)', () => {
      const bus = new EventBus(makeKafkaServiceStub());
      expect(() => bus.subscribe('topic.X', null)).toThrow(/handler/);
    });
  });

  describe('startConsumers', () => {
    it('devuelve false si el consumer esta deshabilitado', async () => {
      const bus = new EventBus(makeKafkaServiceStub(), { consumerEnabled: false });
      await expect(bus.startConsumers()).resolves.toBe(false);
    });

    it('devuelve false si no hay suscripciones', async () => {
      const bus = new EventBus(makeKafkaServiceStub(), { consumerEnabled: true });
      await expect(bus.startConsumers()).resolves.toBe(false);
    });

    it('conecta, se suscribe por topic unico y corre eachMessage', async () => {
      const factory = jest.fn().mockReturnValue({ consumer: jest.fn(() => mockConsumer) });
      const bus = new EventBus(makeKafkaServiceStub(), {
        consumerEnabled: true,
        consumerKafkaFactory: factory,
        consumerGroupId: 'emergencias-test',
      });
      bus.subscribe('t.A', jest.fn());
      bus.subscribe('t.A', jest.fn());
      bus.subscribe('t.B', jest.fn());

      await expect(bus.startConsumers()).resolves.toBe(true);

      expect(factory).toHaveBeenCalledWith({ edaAuthClient: null });
      expect(mockConsumer.connect).toHaveBeenCalled();
      expect(mockConsumer.subscribe).toHaveBeenCalledTimes(2);
      expect(mockConsumer.subscribe.mock.calls.map((c) => c[0].topic).sort()).toEqual(['t.A', 't.B']);
      expect(mockConsumer.run).toHaveBeenCalled();
    });

    it('segundo startConsumers no reconecta', async () => {
      const factory = jest.fn().mockReturnValue({ consumer: jest.fn(() => mockConsumer) });
      const bus = new EventBus(makeKafkaServiceStub(), {
        consumerEnabled: true,
        consumerKafkaFactory: factory,
      });
      bus.subscribe('t.A', jest.fn());
      await bus.startConsumers();
      await bus.startConsumers();
      expect(mockConsumer.connect).toHaveBeenCalledTimes(1);
    });

    it('si connect falla, se desconecta y propaga el error', async () => {
      mockConsumer.connect.mockRejectedValueOnce(new Error('no broker'));
      const factory = jest.fn().mockReturnValue({ consumer: jest.fn(() => mockConsumer) });
      const bus = new EventBus(makeKafkaServiceStub(), {
        consumerEnabled: true,
        consumerKafkaFactory: factory,
      });
      bus.subscribe('t.A', jest.fn());
      await expect(bus.startConsumers()).rejects.toThrow('no broker');
      expect(mockConsumer.disconnect).toHaveBeenCalled();
    });
  });

  describe('dispatchMessage', () => {
    const bus = new EventBus({ publishEvent: jest.fn() }, { consumerEnabled: true });
    const handler = jest.fn();
    bus.subscribe('t.X', handler);

    beforeEach(() => handler.mockClear());

    it('parsea JSON y pasa al handler del topic', async () => {
      await bus.dispatchMessage('t.X', { value: Buffer.from(JSON.stringify({ metadata: { eventId: 'e1' } })) });
      expect(handler).toHaveBeenCalledWith({ metadata: { eventId: 'e1' } });
    });

    it('descarta mensajes con JSON invalido sin lanzar', async () => {
      await expect(
        bus.dispatchMessage('t.X', { value: Buffer.from('{no-json') })
      ).resolves.toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });

    it('descarta mensajes de topics sin handler', async () => {
      await bus.dispatchMessage('t.Z', { value: Buffer.from('{}') });
      expect(handler).not.toHaveBeenCalled();
    });

    it('tolera message sin value', async () => {
      await bus.dispatchMessage('t.X', { value: null });
      expect(handler).toHaveBeenCalledWith(null);
    });
  });

  describe('stopConsumers', () => {
    it('es no-op si no hay consumer activo', async () => {
      const bus = new EventBus(makeKafkaServiceStub());
      await expect(bus.stopConsumers()).resolves.toBeUndefined();
    });

    it('desconecta y limpia el consumer', async () => {
      const factory = jest.fn().mockReturnValue({ consumer: jest.fn(() => mockConsumer) });
      const bus = new EventBus(makeKafkaServiceStub(), {
        consumerEnabled: true,
        consumerKafkaFactory: factory,
      });
      bus.subscribe('t.A', jest.fn());
      await bus.startConsumers();
      await bus.stopConsumers();
      expect(mockConsumer.disconnect).toHaveBeenCalled();
    });
  });

  describe('defaultConsumerKafkaFactory', () => {
    it('crea Kafka con brokers de env y sin SASL si no hay authClient', () => {
      Kafka.mockClear();
      process.env.KAFKA_CONSUMER_BROKERS = 'broker1:9092,broker2:9092';
      defaultConsumerKafkaFactory();
      expect(Kafka).toHaveBeenCalledWith(expect.objectContaining({
        brokers: ['broker1:9092', 'broker2:9092'],
        sasl: undefined,
      }));
    });

    it('agrega SASL/OAUTHBEARER si el authClient esta configurado', () => {
      Kafka.mockClear();
      const authClient = {
        isConfigured: () => true,
        getToken: jest.fn().mockResolvedValue('tkn'),
      };
      defaultConsumerKafkaFactory({ edaAuthClient: authClient });
      const config = Kafka.mock.calls[0][0];
      expect(config.sasl.mechanism).toBe('oauthbearer');
      expect(typeof config.sasl.oauthBearerProvider).toBe('function');
    });

    it('oauthBearerProvider retorna { value: token } del authClient', async () => {
      Kafka.mockClear();
      const authClient = {
        isConfigured: () => true,
        getToken: jest.fn().mockResolvedValue('tkn-123'),
      };
      defaultConsumerKafkaFactory({ edaAuthClient: authClient });
      const provider = Kafka.mock.calls[0][0].sasl.oauthBearerProvider;
      await expect(provider()).resolves.toEqual({ value: 'tkn-123' });
    });

    it('si authClient.isConfigured devuelve false, no agrega SASL', () => {
      Kafka.mockClear();
      defaultConsumerKafkaFactory({ edaAuthClient: { isConfigured: () => false } });
      expect(Kafka.mock.calls[0][0].sasl).toBeUndefined();
    });
  });
});
