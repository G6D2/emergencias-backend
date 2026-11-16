jest.mock('../../security/secure-log', () => ({ secureLog: jest.fn() }));

const path = require('path');
const { EventListener } = require('../../listeners/event-listener');
const { EventConsumer, groupIdFromEnv, concurrencyFromEnv } = require('../../listeners/event-consumer');
const { secureLog } = require('../../security/secure-log');
const { superviseListener } = require('../../listeners/listener-supervisor');

class TestListener extends EventListener {
  constructor(options) {
    super(null, options);
    this.handled = [];
  }

  rules() {
    return [];
  }

  async onMessage(message) {
    this.handled.push(message);
    return 'ok';
  }
}

class OtroListener extends TestListener {}

// Consumer falso con los eventos de instrumentación de kafkajs: emit(nombre,
// payload) llama a los handlers registrados con on().
function buildKafka() {
  const handlers = {};
  const consumer = {
    events: { FETCH_START: 'consumer.fetch_start', CRASH: 'consumer.crash' },
    on: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    emit: (event, payload) => handlers[event] && handlers[event]({ payload }),
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { consumer, kafka: { consumer: jest.fn(() => consumer) } };
}

describe('EventConsumer', () => {
  const saved = {};
  beforeEach(() => {
    [
      'KAFKA_CONSUMER_GROUP_PREFIX',
      'KAFKA_CONSUMER_CONCURRENCY',
      'EDA_CONSUMER_FROM_BEGINNING',
      'EDA_CONSUMER_SINCE',
    ].forEach((k) => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
  });
  afterEach(() => {
    Object.entries(saved).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  });

  describe('group.id', () => {
    it('usa un solo group.id con el prefijo del namespace por default', () => {
      expect(groupIdFromEnv({})).toBe('com.citypass.emergencias.eventos');
      expect(new EventConsumer(buildKafka().kafka, []).groupId).toBe('com.citypass.emergencias.eventos');
    });

    it('el prefijo se puede cambiar por env, pero tiene que empezar con el namespace', () => {
      process.env.KAFKA_CONSUMER_GROUP_PREFIX = 'com.citypass.emergencias.staging';
      expect(new EventConsumer(buildKafka().kafka, []).groupId).toBe('com.citypass.emergencias.staging.eventos');
      process.env.KAFKA_CONSUMER_GROUP_PREFIX = 'emergencias-backend';
      expect(() => new EventConsumer(buildKafka().kafka, [])).toThrow(/tiene que empezar con com\.citypass\.emergencias\./);
    });

    it('acepta un groupId explícito y lo valida', () => {
      expect(new EventConsumer(buildKafka().kafka, [], { groupId: 'com.citypass.emergencias.g' }).groupId)
        .toBe('com.citypass.emergencias.g');
      expect(() => new EventConsumer(buildKafka().kafka, [], { groupId: 'g' })).toThrow(/group\.id/);
    });
  });

  describe('concurrencyFromEnv', () => {
    it('sin la variable: una por topic, con mínimo 1 y tope 3', () => {
      expect(concurrencyFromEnv(0, {})).toBe(1);
      expect(concurrencyFromEnv(1, {})).toBe(1);
      expect(concurrencyFromEnv(2, {})).toBe(2);
      expect(concurrencyFromEnv(3, {})).toBe(3);
      expect(concurrencyFromEnv(6, {})).toBe(3);
      expect(concurrencyFromEnv(6, { KAFKA_CONSUMER_CONCURRENCY: '' })).toBe(3);
    });

    it('acepta cualquier entero >= 1, también por encima del default', () => {
      expect(concurrencyFromEnv(6, { KAFKA_CONSUMER_CONCURRENCY: '1' })).toBe(1);
      expect(concurrencyFromEnv(6, { KAFKA_CONSUMER_CONCURRENCY: '6' })).toBe(6);
      expect(concurrencyFromEnv(2, { KAFKA_CONSUMER_CONCURRENCY: ' 4 ' })).toBe(4);
    });

    it.each(['0', '-1', '2.5', 'abc', '3x', 'NaN', 'Infinity', '  '])(
      'un valor inválido (%p) cae al default',
      (value) => {
        expect(concurrencyFromEnv(6, { KAFKA_CONSUMER_CONCURRENCY: value })).toBe(3);
        expect(concurrencyFromEnv(2, { KAFKA_CONSUMER_CONCURRENCY: value })).toBe(2);
      }
    );

    it('lee process.env por default', () => {
      process.env.KAFKA_CONSUMER_CONCURRENCY = '4';
      expect(concurrencyFromEnv(6)).toBe(4);
    });
  });

  it('requiere una instancia de Kafka', () => {
    expect(() => new EventConsumer(null, [])).toThrow(/Kafka/);
  });

  it('dos listeners en el mismo topic fallan al construir', () => {
    const listeners = [new TestListener({ topic: 't' }), new OtroListener({ topic: 't' })];
    expect(() => new EventConsumer(buildKafka().kafka, listeners)).toThrow(/mismo topic "t"/);
  });

  describe('start', () => {
    it('crea UN consumer, se suscribe a todos los topics y procesa una partición por topic en paralelo', async () => {
      const { kafka, consumer } = buildKafka();
      const listeners = [
        new TestListener({ topic: 'a' }),
        new OtroListener({ topic: 'b', fromBeginning: false }),
      ];

      await expect(new EventConsumer(kafka, listeners).start()).resolves.toBe(true);

      expect(kafka.consumer).toHaveBeenCalledTimes(1);
      expect(kafka.consumer).toHaveBeenCalledWith({ groupId: 'com.citypass.emergencias.eventos' });
      expect(consumer.subscribe).toHaveBeenCalledWith({ topic: 'a', fromBeginning: true });
      expect(consumer.subscribe).toHaveBeenCalledWith({ topic: 'b', fromBeginning: false });
      expect(consumer.run).toHaveBeenCalledTimes(1);
      expect(consumer.run.mock.calls[0][0].partitionsConsumedConcurrently).toBe(2);
    });

    it('por default procesa una partición por topic en paralelo, hasta 3', async () => {
      const { kafka, consumer } = buildKafka();
      // Seis topics, como en producción.
      const listeners = ['a', 'b', 'c', 'd', 'e', 'f'].map((topic) => new TestListener({ topic }));
      await new EventConsumer(kafka, listeners).start();

      expect(consumer.subscribe).toHaveBeenCalledTimes(6);
      expect(consumer.run.mock.calls[0][0].partitionsConsumedConcurrently).toBe(3);
    });

    it('KAFKA_CONSUMER_CONCURRENCY cambia la concurrencia y queda en el log de arranque', async () => {
      process.env.KAFKA_CONSUMER_CONCURRENCY = '5';
      const { kafka, consumer } = buildKafka();
      await new EventConsumer(kafka, [new TestListener({ topic: 'a' }), new OtroListener({ topic: 'b' })]).start();

      expect(consumer.run.mock.calls[0][0].partitionsConsumedConcurrently).toBe(5);
      expect(secureLog).toHaveBeenCalledWith(
        'info',
        'EventConsumer escuchando',
        expect.objectContaining({ concurrency: 5 })
      );
    });

    it('una KAFKA_CONSUMER_CONCURRENCY inválida cae al default y avisa en el log', async () => {
      process.env.KAFKA_CONSUMER_CONCURRENCY = 'muchas';
      const { kafka, consumer } = buildKafka();
      await new EventConsumer(kafka, [new TestListener({ topic: 'a' }), new OtroListener({ topic: 'b' })]).start();

      expect(consumer.run.mock.calls[0][0].partitionsConsumedConcurrently).toBe(2);
      expect(secureLog).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('KAFKA_CONSUMER_CONCURRENCY inválida'),
        { value: 'muchas', default: 2 }
      );
    });

    it('es idempotente', async () => {
      const { kafka } = buildKafka();
      const eventConsumer = new EventConsumer(kafka, [new TestListener({ topic: 'a' })]);
      await eventConsumer.start();
      await expect(eventConsumer.start()).resolves.toBe(true);
      expect(kafka.consumer).toHaveBeenCalledTimes(1);
    });

    it('sin listeners con topic no crea consumer', async () => {
      const { kafka } = buildKafka();
      await expect(new EventConsumer(kafka, [new TestListener({})]).start()).resolves.toBe(false);
      await expect(new EventConsumer(kafka, []).start()).resolves.toBe(false);
      expect(kafka.consumer).not.toHaveBeenCalled();
    });

    it('un listener sin topic no se suscribe, los demás sí', async () => {
      const { kafka, consumer } = buildKafka();
      await new EventConsumer(kafka, [new TestListener({}), new OtroListener({ topic: 'b' })]).start();
      expect(consumer.subscribe).toHaveBeenCalledTimes(1);
      expect(consumer.subscribe).toHaveBeenCalledWith({ topic: 'b', fromBeginning: true });
    });

    it('falla sin conectar si una regla de un listener es inválida', async () => {
      class Rota extends EventListener {}
      const { kafka } = buildKafka();
      const rota = new Rota(null, { topic: 't', rulesDir: path.join(__dirname, 'fixtures', 'rules-invalidas') });

      await expect(new EventConsumer(kafka, [rota]).start()).rejects.toThrow(/BusinessRule/);
      expect(kafka.consumer).not.toHaveBeenCalled();
    });

    it('si el consumer falla, desconecta y relanza', async () => {
      const { kafka, consumer } = buildKafka();
      consumer.connect.mockRejectedValue(new Error('no broker'));
      const eventConsumer = new EventConsumer(kafka, [new TestListener({ topic: 'a' })]);

      await expect(eventConsumer.start()).rejects.toThrow('no broker');
      expect(consumer.disconnect).toHaveBeenCalled();
      expect(eventConsumer.consumer).toBeNull();
      expect(eventConsumer.status().running).toBe(false);
    });
  });

  describe('despacho por topic', () => {
    it('cada mensaje va al listener de su topic', async () => {
      const { kafka, consumer } = buildKafka();
      const a = new TestListener({ topic: 'a' });
      const b = new OtroListener({ topic: 'b' });
      await new EventConsumer(kafka, [a, b]).start();
      const { eachMessage } = consumer.run.mock.calls[0][0];

      await expect(eachMessage({ topic: 'b', message: { value: 'mb' } })).resolves.toBe('ok');
      await eachMessage({ topic: 'a', message: { value: 'ma' } });

      expect(a.handled).toEqual([{ value: 'ma' }]);
      expect(b.handled).toEqual([{ value: 'mb' }]);
    });

    it('un topic sin listener se ignora (el offset avanza)', async () => {
      const { kafka, consumer } = buildKafka();
      await new EventConsumer(kafka, [new TestListener({ topic: 'a' })]).start();
      const { eachMessage } = consumer.run.mock.calls[0][0];
      await expect(eachMessage({ topic: 'otro', message: {} })).resolves.toBeNull();
    });

    it('propaga el error del listener para que kafkajs reentregue', async () => {
      const { kafka, consumer } = buildKafka();
      const a = new TestListener({ topic: 'a' });
      a.onMessage = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await new EventConsumer(kafka, [a]).start();
      const { eachMessage } = consumer.run.mock.calls[0][0];
      await expect(eachMessage({ topic: 'a', message: {} })).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('estado para /health', () => {
    it('no corre antes de start, corre después y cada fetch marca lastPollAt', async () => {
      const { kafka, consumer } = buildKafka();
      const eventConsumer = new EventConsumer(kafka, [new TestListener({ topic: 'a' })]);
      expect(eventConsumer.status()).toEqual({
        name: 'EventConsumer', groupId: 'com.citypass.emergencias.eventos', running: false, lastPollAt: null,
      });

      await eventConsumer.start();
      expect(eventConsumer.status().running).toBe(true);
      consumer.emit(consumer.events.FETCH_START, {});
      expect(Date.parse(eventConsumer.status().lastPollAt)).not.toBeNaN();
    });

    it('un CRASH sin restart lo marca caído, suelta el consumer y avisa por onCrash', async () => {
      const { kafka, consumer } = buildKafka();
      const eventConsumer = new EventConsumer(kafka, [new TestListener({ topic: 'a' })]);
      eventConsumer.onCrash = jest.fn();
      await eventConsumer.start();

      const error = new Error('Topic authorization failed');
      consumer.emit(consumer.events.CRASH, { error, restart: false });

      expect(eventConsumer.status().running).toBe(false);
      expect(eventConsumer.consumer).toBeNull();
      expect(eventConsumer.onCrash).toHaveBeenCalledWith(error);
    });

    it('un CRASH con restart lo deja en manos de kafkajs (sigue corriendo)', async () => {
      const { kafka, consumer } = buildKafka();
      const eventConsumer = new EventConsumer(kafka, [new TestListener({ topic: 'a' })]);
      eventConsumer.onCrash = jest.fn();
      await eventConsumer.start();

      consumer.emit(consumer.events.CRASH, { error: new Error('KafkaJSNumberOfRetriesExceeded'), restart: true });

      expect(eventConsumer.status().running).toBe(true);
      expect(eventConsumer.onCrash).not.toHaveBeenCalled();
    });

    it('listenerStatuses: un elemento por listener con el estado del consumer; sin topic, disabled', () => {
      const eventConsumer = new EventConsumer(buildKafka().kafka, [
        new TestListener({ topic: 'a' }),
        new OtroListener({}),
      ]);
      const consumerStatus = {
        running: true, lastPollAt: '2026-11-16T00:00:00.000Z', status: 'running', nextRetryAt: null,
      };

      expect(eventConsumer.listenerStatuses(consumerStatus)).toEqual([
        { name: 'TestListener', running: true, lastPollAt: '2026-11-16T00:00:00.000Z', status: 'running', nextRetryAt: null },
        { name: 'OtroListener', running: false, lastPollAt: null, status: 'disabled', nextRetryAt: null },
      ]);
    });
  });

  it('stop desconecta el consumer y es seguro sin start', async () => {
    const { kafka, consumer } = buildKafka();
    const eventConsumer = new EventConsumer(kafka, [new TestListener({ topic: 'a' })]);
    await expect(eventConsumer.stop()).resolves.toBeUndefined();

    await eventConsumer.start();
    await eventConsumer.stop();
    expect(consumer.disconnect).toHaveBeenCalledTimes(1);
    expect(eventConsumer.consumer).toBeNull();
    expect(eventConsumer.status().running).toBe(false);
  });

  it('funciona con superviseListener: arranca una vez y reporta running', async () => {
    const { kafka } = buildKafka();
    const eventConsumer = new EventConsumer(kafka, [new TestListener({ topic: 'a' }), new OtroListener({ topic: 'b' })]);
    const handle = superviseListener(eventConsumer);
    await handle.ready;

    expect(kafka.consumer).toHaveBeenCalledTimes(1);
    expect(handle.status()).toMatchObject({ name: 'EventConsumer', status: 'running', running: true });
    await handle.stop();
  });
});
