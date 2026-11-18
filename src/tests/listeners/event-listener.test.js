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
  constructor(rules) {
    super(buildKafka().kafka, { topic: 't' });
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

const toMessage = (value) => ({ value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });

describe('EventListener', () => {
  // Los defaults de arranque se leen del entorno: que una variable exportada en
  // la shell no cambie el resultado de estos tests.
  const savedEnv = {};
  beforeEach(() => {
    ['EDA_CONSUMER_FROM_BEGINNING', 'EDA_CONSUMER_SINCE'].forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
  });
  afterEach(() => {
    Object.entries(savedEnv).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  });

  it('no se puede instanciar directamente', () => {
    expect(() => new EventListener(buildKafka().kafka, { topic: 't' })).toThrow(/abstracto/);
  });

  it('una subclase sin rulesDir ni rules() falla al evaluar un evento', async () => {
    class SinRules extends EventListener {}
    const listener = new SinRules(buildKafka().kafka, { topic: 't' });
    await expect(listener.handle({ a: 1 })).rejects.toThrow(/debe definir rulesDir o implementar rules/);
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

  it('onMessage parsea el JSON y delega en handle', async () => {
    const listener = new TestListener(buildKafka().kafka, { topic: 't' });

    await listener.onMessage(toMessage({ metadata: { eventId: 'e1' } }));

    expect(listener.handled).toEqual([{ metadata: { eventId: 'e1' } }]);
  });

  it('descarta mensajes con JSON invalido sin llamar a handle', async () => {
    const listener = new TestListener(buildKafka().kafka, { topic: 't' });
    await expect(listener.onMessage(toMessage('{no-json'))).resolves.toBeNull();
    expect(listener.handled).toEqual([]);
  });

  it('propaga los errores transitorios para que Kafka reentregue', async () => {
    class Falla extends EventListener {
      async handle() {
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
      }
    }
    const listener = new Falla(buildKafka().kafka, { topic: 't' });
    await expect(listener.onMessage(toMessage({}))).rejects.toThrow('Connection terminated');
  });

  it('un error permanente se descarta, queda registrado y no se reentrega', async () => {
    class Falla extends EventListener {
      async handle() {
        throw new Error('payload invalido');
      }
    }
    const factory = { process: jest.fn(), recordDiscard: jest.fn().mockResolvedValue(true) };
    const listener = new Falla(buildKafka().kafka, { topic: 't', factory });
    const event = { metadata: { eventId: 'e1' }, data: {} };

    await expect(listener.onMessage(toMessage(event))).resolves.toBeNull();
    expect(factory.recordDiscard).toHaveBeenCalledWith(
      { metadata: { eventId: 'e1' }, data: {} },
      'payload invalido'
    );
  });

  it('una reentrega que la dedup descarta deja un log info con eventId, tipo y tópico, sin datos del evento', async () => {
    const factory = { process: jest.fn().mockResolvedValue({ duplicate: true }) };
    const listener = new RuleListener([new CapacidadAlta()]);
    listener.factory = factory;
    const event = {
      metadata: { eventId: 'a1000000-0000-4000-8000-000000000001', eventType: 'EventoComunitarioPublicado', source: 'grupo7' },
      data: { capacidad: 900, latitud: -34.6, longitud: -58.4 },
    };
    secureLog.mockClear();

    await listener.onMessage({ ...toMessage(event), offset: '42' });

    const duplicados = secureLog.mock.calls.filter(([, message]) => /descarto un duplicado/.test(message));
    expect(duplicados).toEqual([[
      'info',
      'RuleListener descarto un duplicado (eventId ya registrado en eventos_procesados)',
      {
        topic: 't',
        eventId: 'a1000000-0000-4000-8000-000000000001',
        eventType: 'EventoComunitarioPublicado',
        source: 'grupo7',
        offset: '42',
      },
    ]]);
    expect(JSON.stringify(duplicados)).not.toMatch(/latitud|capacidad/);
  });

  it('un evento nuevo no deja el log de duplicado', async () => {
    const factory = { process: jest.fn().mockResolvedValue({ duplicate: false }) };
    const listener = new RuleListener([new CapacidadAlta()]);
    listener.factory = factory;
    secureLog.mockClear();

    await listener.onMessage(toMessage({ metadata: { eventId: 'e1' }, data: { capacidad: 900 } }));

    expect(factory.process).toHaveBeenCalledTimes(1);
    expect(secureLog.mock.calls.some(([, message]) => /duplicado/.test(message))).toBe(false);
  });

  it('si registrar el descarte falla por un error transitorio, se reentrega', async () => {
    class Falla extends EventListener {
      async handle() {
        throw new Error('payload invalido');
      }
    }
    const factory = {
      process: jest.fn(),
      recordDiscard: jest.fn().mockRejectedValue(Object.assign(new Error('db caida'), { code: 'ECONNREFUSED' })),
    };
    const listener = new Falla(buildKafka().kafka, { topic: 't', factory });
    await expect(listener.onMessage(toMessage({ metadata: { eventId: 'e1' } }))).rejects.toThrow('db caida');
  });

  it('si registrar el descarte falla por un error permanente, igual avanza', async () => {
    class Falla extends EventListener {
      async handle() {
        throw new Error('payload invalido');
      }
    }
    const factory = {
      process: jest.fn(),
      recordDiscard: jest.fn().mockRejectedValue(Object.assign(new Error('uuid invalido'), { code: '22P02' })),
    };
    const listener = new Falla(buildKafka().kafka, { topic: 't', factory });
    await expect(listener.onMessage(toMessage({ metadata: { eventId: 'x' } }))).resolves.toBeNull();
  });

  it('un error transitorio del decoder se propaga y uno permanente se descarta', async () => {
    const transient = { decode: jest.fn().mockRejectedValue(Object.assign(new Error('registry caido'), { transient: true })) };
    const listener = new TestListener(buildKafka().kafka, { topic: 't', decoder: transient });
    await expect(listener.onMessage({ value: Buffer.from([0]) })).rejects.toThrow('registry caido');

    const permanent = { decode: jest.fn().mockRejectedValue(Object.assign(new Error('Avro invalido'), { permanent: true })) };
    const otro = new TestListener(buildKafka().kafka, { topic: 't', decoder: permanent });
    await expect(otro.onMessage({ value: Buffer.from([0]) })).resolves.toBeNull();
    expect(otro.handled).toHaveLength(0);
  });
});

describe('EventListener: arranque sin offset y piso EDA_CONSUMER_SINCE', () => {
  const ENV_KEYS = ['EDA_CONSUMER_FROM_BEGINNING', 'EDA_CONSUMER_SINCE'];
  const saved = {};

  beforeEach(() => {
    ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });

  const at = (iso) => String(new Date(iso).getTime());
  const message = (iso, value = { metadata: { eventId: 'e1' } }) => ({ ...toMessage(value), offset: '7', timestamp: at(iso) });

  it('sin offset commiteado lee desde el principio por default', () => {
    expect(new TestListener(buildKafka().kafka, { topic: 't' }).fromBeginning).toBe(true);
  });

  it('EDA_CONSUMER_FROM_BEGINNING=false vuelve a arrancar en el final del topic', () => {
    process.env.EDA_CONSUMER_FROM_BEGINNING = 'false';
    expect(new TestListener(buildKafka().kafka, { topic: 't' }).fromBeginning).toBe(false);
  });

  it('la opción del constructor pisa a la variable de entorno', () => {
    process.env.EDA_CONSUMER_FROM_BEGINNING = 'false';
    expect(new TestListener(buildKafka().kafka, { topic: 't', fromBeginning: true }).fromBeginning).toBe(true);
  });

  it('un EDA_CONSUMER_SINCE que no es fecha falla al construir, no al primer mensaje', () => {
    process.env.EDA_CONSUMER_SINCE = 'ayer';
    expect(() => new TestListener(buildKafka().kafka, { topic: 't' })).toThrow(/EDA_CONSUMER_SINCE invalido/);
  });

  it('saltea sin decodificar ni procesar un mensaje anterior al piso', async () => {
    process.env.EDA_CONSUMER_SINCE = '2026-11-05T15:00:00Z';
    const decoder = { decode: jest.fn() };
    const listener = new TestListener(buildKafka().kafka, { topic: 't', decoder });

    await expect(listener.onMessage(message('2026-11-02T12:00:00Z'))).resolves.toBeNull();

    expect(decoder.decode).not.toHaveBeenCalled();
    expect(listener.handled).toEqual([]);
  });

  it('procesa los mensajes desde el piso en adelante', async () => {
    const listener = new TestListener(buildKafka().kafka, { topic: 't', consumeSince: '2026-11-05T15:00:00Z' });

    await listener.onMessage(message('2026-11-05T15:00:00Z', { metadata: { eventId: 'justo' } }));
    await listener.onMessage(message('2026-11-05T18:30:00Z', { metadata: { eventId: 'despues' } }));

    expect(listener.handled.map((e) => e.metadata.eventId)).toEqual(['justo', 'despues']);
  });

  it('sin piso procesa todo, aunque el mensaje sea viejo', async () => {
    const listener = new TestListener(buildKafka().kafka, { topic: 't' });
    await listener.onMessage(message('2026-10-01T00:00:00Z'));
    expect(listener.handled).toHaveLength(1);
  });

  it.each([
    ['05/11/2026'],
    ['2026-11-05T15:00:00'],
    ['5'],
  ])('EDA_CONSUMER_SINCE "%s" (sin formato ISO con zona) falla al construir', (value) => {
    process.env.EDA_CONSUMER_SINCE = value;
    expect(() => new TestListener(buildKafka().kafka, { topic: 't' })).toThrow(/ISO 8601 con zona/);
  });

  it('acepta ISO con offset y lo normaliza a UTC', () => {
    process.env.EDA_CONSUMER_SINCE = '2026-11-05T12:00:00-03:00';
    expect(new TestListener(buildKafka().kafka, { topic: 't' }).consumeSince.toISOString()).toBe('2026-11-05T15:00:00.000Z');
  });

  it('un piso en el futuro falla al construir (saltearía todo lo que llegue)', () => {
    process.env.EDA_CONSUMER_SINCE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(() => new TestListener(buildKafka().kafka, { topic: 't' })).toThrow(/en el futuro/);
  });

  it.each([['-1'], [null], [''], ['0']])('un mensaje con timestamp %p se procesa aunque haya piso', async (timestamp) => {
    const listener = new TestListener(buildKafka().kafka, { topic: 't', consumeSince: '2026-11-05T15:00:00Z' });
    await listener.onMessage({ ...toMessage({ metadata: { eventId: 'e1' } }), offset: '1', timestamp });
    expect(listener.handled).toHaveLength(1);
  });

  it.each([['FALSE'], ['0'], ['no'], ['off']])('EDA_CONSUMER_FROM_BEGINNING=%s también apaga la lectura desde el principio', (value) => {
    process.env.EDA_CONSUMER_FROM_BEGINNING = value;
    expect(new TestListener(buildKafka().kafka, { topic: 't' }).fromBeginning).toBe(false);
  });

  it('un mensaje sin timestamp se procesa aunque haya piso', async () => {
    const listener = new TestListener(buildKafka().kafka, { topic: 't', consumeSince: '2026-11-05T15:00:00Z' });
    await listener.onMessage(toMessage({ metadata: { eventId: 'e1' } }));
    expect(listener.handled).toHaveLength(1);
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

  it('onMessage devuelve los resultados del template', async () => {
    const listener = new RuleListener([new SiempreAplica()]);
    await expect(listener.onMessage(toMessage(evento))).resolves.toEqual([{ type: 'Auditoria', payload: {} }]);
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
