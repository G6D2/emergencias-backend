jest.mock('../../security/secure-log', () => ({ secureLog: jest.fn() }));

const { EventListener } = require('../../listeners/event-listener');

class TestListener extends EventListener {
  constructor(kafka, options) {
    super(kafka, options);
    this.handled = [];
  }

  async handle(event) {
    this.handled.push(event);
  }
}

function buildKafka() {
  const consumer = {
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    run: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { consumer, kafka: { consumer: jest.fn(() => consumer) } };
}

const toMessage = (value) => ({ value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });

describe('EventListener', () => {
  it('no se puede instanciar directamente', () => {
    expect(() => new EventListener(buildKafka().kafka, { topic: 't' })).toThrow(/abstracto/);
  });

  it('requiere una instancia de Kafka', () => {
    expect(() => new TestListener(null, { topic: 't' })).toThrow(/Kafka/);
  });

  it('una subclase sin handle() falla al recibir un evento', async () => {
    class SinHandle extends EventListener {}
    const listener = new SinHandle(buildKafka().kafka, { topic: 't' });
    await expect(listener.onMessage(toMessage({ a: 1 }))).rejects.toThrow(/implementar handle/);
  });

  it('usa un groupId por listener por default', () => {
    expect(new TestListener(buildKafka().kafka, { topic: 't' }).groupId).toBe('emergencias-backend.TestListener');
    expect(new TestListener(buildKafka().kafka, { topic: 't', groupId: 'g' }).groupId).toBe('g');
  });

  it('start conecta, se suscribe al topic y corre el consumer', async () => {
    const { kafka, consumer } = buildKafka();
    const listener = new TestListener(kafka, { topic: 'espacios.evento' });

    await expect(listener.start()).resolves.toBe(true);

    expect(kafka.consumer).toHaveBeenCalledWith({ groupId: 'emergencias-backend.TestListener' });
    expect(consumer.subscribe).toHaveBeenCalledWith({ topic: 'espacios.evento', fromBeginning: false });
    expect(consumer.run).toHaveBeenCalledTimes(1);
  });

  it('start es idempotente', async () => {
    const { kafka } = buildKafka();
    const listener = new TestListener(kafka, { topic: 't' });
    await listener.start();
    await expect(listener.start()).resolves.toBe(true);
    expect(kafka.consumer).toHaveBeenCalledTimes(1);
  });

  it('start sin topic no crea consumer', async () => {
    const { kafka } = buildKafka();
    const listener = new TestListener(kafka, {});
    await expect(listener.start()).resolves.toBe(false);
    expect(kafka.consumer).not.toHaveBeenCalled();
  });

  it('start desconecta y relanza si el consumer falla', async () => {
    const { kafka, consumer } = buildKafka();
    consumer.connect.mockRejectedValue(new Error('no broker'));
    const listener = new TestListener(kafka, { topic: 't' });

    await expect(listener.start()).rejects.toThrow('no broker');
    expect(consumer.disconnect).toHaveBeenCalled();
    expect(listener.consumer).toBeNull();
  });

  it('eachMessage parsea el JSON y delega en handle', async () => {
    const { kafka, consumer } = buildKafka();
    const listener = new TestListener(kafka, { topic: 't' });
    await listener.start();

    const { eachMessage } = consumer.run.mock.calls[0][0];
    await eachMessage({ topic: 't', message: toMessage({ metadata: { eventId: 'e1' } }) });

    expect(listener.handled).toEqual([{ metadata: { eventId: 'e1' } }]);
  });

  it('descarta mensajes con JSON invalido sin llamar a handle', async () => {
    const listener = new TestListener(buildKafka().kafka, { topic: 't' });
    await expect(listener.onMessage(toMessage('{no-json'))).resolves.toBeUndefined();
    expect(listener.handled).toEqual([]);
  });

  it('propaga errores de handle para que Kafka reentregue', async () => {
    class Falla extends EventListener {
      async handle() {
        throw new Error('boom');
      }
    }
    const listener = new Falla(buildKafka().kafka, { topic: 't' });
    await expect(listener.onMessage(toMessage({}))).rejects.toThrow('boom');
  });

  it('stop desconecta el consumer y es seguro sin start', async () => {
    const { kafka, consumer } = buildKafka();
    const listener = new TestListener(kafka, { topic: 't' });
    await expect(listener.stop()).resolves.toBeUndefined();

    await listener.start();
    await listener.stop();
    expect(consumer.disconnect).toHaveBeenCalledTimes(1);
    expect(listener.consumer).toBeNull();
  });
});
