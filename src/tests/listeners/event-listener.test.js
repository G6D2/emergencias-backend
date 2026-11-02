jest.mock('../../security/secure-log', () => ({ secureLog: jest.fn() }));

const { secureLog } = require('../../security/secure-log');
const { EventListener } = require('../../listeners/event-listener');
const { BusinessRule } = require('../../listeners/business-rule');

class TestListener extends EventListener {
  constructor(kafka, options) {
    super(kafka, options);
    this.handled = [];
  }

  rules() {
    return [];
  }

  async handle(event) {
    this.handled.push(event);
  }
}

class RuleListener extends EventListener {
  constructor(rules, options = {}) {
    super(buildKafka().kafka, { topic: 't', ...options });
    this.ruleList = rules;
  }

  rules() {
    return this.ruleList;
  }
}

class CapacidadAlta extends BusinessRule {
  appliesTo({ data }) {
    return data.capacidad >= 500;
  }

  apply({ metadata, data }) {
    return { type: 'CoberturaPreventiva', payload: { eventId: metadata.eventId, capacidad: data.capacidad } };
  }
}

class SiempreAplica extends BusinessRule {
  appliesTo() {
    return true;
  }

  async apply() {
    return { type: 'Auditoria', payload: {} };
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

  it('una subclase sin rulesDir ni rules() falla al recibir un evento', async () => {
    class SinRules extends EventListener {}
    const listener = new SinRules(buildKafka().kafka, { topic: 't' });
    await expect(listener.onMessage(toMessage({ a: 1 }))).rejects.toThrow(/debe definir rulesDir o implementar rules/);
  });

  it('carga las reglas de rulesDir una sola vez y las aplica', async () => {
    const path = require('path');
    class ConCarpeta extends EventListener {}
    const listener = new ConCarpeta(buildKafka().kafka, {
      topic: 't',
      rulesDir: path.join(__dirname, 'fixtures', 'rules'),
    });

    const outcomes = await listener.handle({ metadata: { eventId: 'e1' }, data: { capacidad: 900 } });
    expect(outcomes.map((o) => o.type)).toEqual(['CapacidadAlta', 'Siempre']);
    expect(listener.rules()).toBe(listener.rules());
  });

  it('start falla sin conectar si una regla de rulesDir es invalida', async () => {
    const path = require('path');
    class Rota extends EventListener {}
    const { kafka } = buildKafka();
    const listener = new Rota(kafka, { topic: 't', rulesDir: path.join(__dirname, 'fixtures', 'rules-invalidas') });

    await expect(listener.start()).rejects.toThrow(/BusinessRule/);
    expect(kafka.consumer).not.toHaveBeenCalled();
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
    await expect(listener.onMessage(toMessage('{no-json'))).resolves.toBeNull();
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

describe('EventListener.handle (template method)', () => {
  const evento = { metadata: { eventId: 'e1' }, data: { capacidad: 800 } };

  it('sin reglas no devuelve resultados', async () => {
    await expect(new RuleListener([]).handle(evento)).resolves.toEqual([]);
  });

  it('devuelve los resultados de las reglas que aplican, en orden', async () => {
    const listener = new RuleListener([new CapacidadAlta(), new SiempreAplica()]);
    await expect(listener.handle(evento)).resolves.toEqual([
      { type: 'CoberturaPreventiva', payload: { eventId: 'e1', capacidad: 800 } },
      { type: 'Auditoria', payload: {} },
    ]);
  });

  it('omite las reglas que no aplican', async () => {
    const listener = new RuleListener([new CapacidadAlta(), new SiempreAplica()]);
    const outcomes = await listener.handle({ metadata: {}, data: { capacidad: 10 } });
    expect(outcomes.map((o) => o.type)).toEqual(['Auditoria']);
  });

  it('buildContext tolera eventos sin metadata/data', async () => {
    const listener = new RuleListener([new SiempreAplica()]);
    expect(listener.buildContext(null)).toEqual({ metadata: {}, data: {} });
    await expect(listener.handle(undefined)).resolves.toHaveLength(1);
  });

  it('las subclases pueden sobreescribir buildContext', async () => {
    class Normaliza extends RuleListener {
      buildContext(event) {
        const ctx = super.buildContext(event);
        return { ...ctx, data: { capacidad: Number(ctx.data.capacidad) } };
      }
    }
    const outcomes = await new Normaliza([new CapacidadAlta()]).handle({ data: { capacidad: '900' } });
    expect(outcomes[0].payload.capacidad).toBe(900);
  });

  it('falla si una regla devuelve un resultado sin type', async () => {
    class SinType extends SiempreAplica {
      apply() {
        return { payload: {} };
      }
    }
    await expect(new RuleListener([new SinType()]).handle(evento)).rejects.toThrow(/SinType.apply\(\) debe devolver/);
  });

  it('onMessage le pasa los resultados y el contexto a la factory, y los devuelve', async () => {
    const factory = { process: jest.fn().mockResolvedValue(undefined) };
    const listener = new RuleListener([new SiempreAplica()], { factory });

    await expect(listener.onMessage(toMessage(evento))).resolves.toEqual([{ type: 'Auditoria', payload: {} }]);

    expect(factory.process).toHaveBeenCalledWith([{ type: 'Auditoria', payload: {} }], {
      metadata: evento.metadata,
      data: evento.data,
    });
  });

  it('onMessage no llama a la factory si no hay resultados', async () => {
    const factory = { process: jest.fn() };
    const listener = new RuleListener([], { factory });

    await expect(listener.onMessage(toMessage(evento))).resolves.toEqual([]);

    expect(factory.process).not.toHaveBeenCalled();
  });

  it('onMessage sin resultados funciona sin factory', async () => {
    await expect(new RuleListener([]).onMessage(toMessage(evento))).resolves.toEqual([]);
  });

  it('onMessage con resultados y sin factory falla: el resultado no se pierde', async () => {
    const listener = new RuleListener([new SiempreAplica()]);

    await expect(listener.onMessage(toMessage(evento))).rejects.toThrow(/tiene resultados y no tiene factory/);

    expect(secureLog).toHaveBeenCalledWith('error', 'RuleListener no pudo aplicar los resultados', {
      eventId: evento.metadata.eventId,
      outcomes: ['Auditoria'],
      message: expect.stringMatching(/no tiene factory/),
    });
  });

  it('onMessage propaga el error de la factory para que Kafka reentregue', async () => {
    const factory = { process: jest.fn().mockRejectedValue(new Error('boom')) };
    const listener = new RuleListener([new SiempreAplica()], { factory });

    await expect(listener.onMessage(toMessage(evento))).rejects.toThrow('boom');
  });
});

describe('BusinessRule', () => {
  it('no se puede instanciar directamente', () => {
    expect(() => new BusinessRule()).toThrow(/abstracta/);
  });

  it('una subclase debe implementar appliesTo y apply', () => {
    class Vacia extends BusinessRule {}
    const rule = new Vacia();
    expect(() => rule.appliesTo({})).toThrow(/implementar appliesTo/);
    expect(() => rule.apply({})).toThrow(/implementar apply/);
  });
});
