const { randomUUID } = require('crypto');
const { getPool, closePool } = require('../../db/pool');
const { EmergencyRepository } = require('../../repositories/emergency.repository');
const { EventListener, BusinessRule, createOutcomeFactory } = require('../../listeners');

class Publicar extends BusinessRule {
  constructor(topic, type) {
    super();
    this.topic = topic;
    this.type = type;
  }

  appliesTo() {
    return true;
  }

  apply({ data }) {
    return { type: 'PublicarEvento', payload: { topic: this.topic, event: { type: this.type, correlationId: data.correlationId, data } } };
  }
}

class Devolver extends BusinessRule {
  constructor(outcome) {
    super();
    this.outcome = outcome;
  }

  appliesTo() {
    return true;
  }

  apply() {
    return this.outcome;
  }
}

class TestListener extends EventListener {
  constructor(factory, rules) {
    super({ consumer: jest.fn() }, { topic: 't', factory });
    this.ruleList = rules;
  }

  rules() {
    return this.ruleList;
  }
}

const toMessage = (value) => ({ value: Buffer.from(JSON.stringify(value)) });

describe('OutcomeFactory (integración contra Postgres real)', () => {
  let pool;
  let factory;
  let topic;

  const rowsOf = async () => {
    const { rows } = await pool.query('SELECT id, topic, payload, status FROM outbox_events WHERE topic = $1 ORDER BY created_at', [topic]);
    return rows;
  };

  beforeAll(() => {
    process.env.LOCATION_ENCRYPTION_KEY =
      process.env.LOCATION_ENCRYPTION_KEY
      || 'flxqyJtbe6+mibyHqK76N6LSnFe0w22hnyDZg9KWIcs=';
    pool = getPool();
    factory = createOutcomeFactory({ pool, emergencyRepository: new EmergencyRepository(pool) });
  });

  beforeEach(() => {
    topic = `test.listeners.${randomUUID()}`;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM outbox_events WHERE topic = $1', [topic]);
  });

  afterAll(async () => {
    await closePool();
  });

  it('un mensaje con dos resultados deja dos eventos PENDING en el outbox', async () => {
    const listener = new TestListener(factory, [new Publicar(topic, 'Primero'), new Publicar(topic, 'Segundo')]);
    const eventId = randomUUID();

    await listener.onMessage(toMessage({ metadata: { eventId }, data: { correlationId: 'c1' } }));

    const rows = await rowsOf();
    expect(rows.map((row) => row.payload.type).sort()).toEqual(['Primero', 'Segundo']);
    rows.forEach((row) => {
      expect(row.status).toBe('PENDING');
      expect(row.payload.eventId).toBe(row.id);
      expect(row.payload.causationId).toBe(eventId);
      expect(row.payload.correlationId).toBe('c1');
    });
  });

  it('si falla un resultado no queda nada escrito de los anteriores', async () => {
    const listener = new TestListener(factory, [
      new Publicar(topic, 'Primero'),
      new Devolver({ type: 'PublicarEvento', payload: { event: { type: 'SinTopic' } } }),
    ]);

    await expect(listener.onMessage(toMessage({ metadata: { eventId: randomUUID() }, data: {} }))).rejects.toThrow(/requiere topic/);

    await expect(rowsOf()).resolves.toEqual([]);
  });

  it('un type sin handler falla y no deja nada escrito', async () => {
    const listener = new TestListener(factory, [
      new Publicar(topic, 'Primero'),
      new Devolver({ type: 'TypeSinHandler', payload: {} }),
    ]);

    await expect(listener.onMessage(toMessage({ metadata: { eventId: randomUUID() }, data: {} }))).rejects.toThrow(/TypeSinHandler/);

    await expect(rowsOf()).resolves.toEqual([]);
  });
});
