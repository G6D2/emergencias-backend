const { OutboxPublisher, resolvePublishSince, isOutboxPublisherEnabled } = require('../services/outbox-publisher');

// Cada reclamo devuelve el siguiente lote de `batches` (o `events` una sola
// vez) y después nada: runOnce reclama hasta que no salen más eventos.
function createPool({ events = [], batches = null, claimError = null, updateRowCount = 1 } = {}) {
  const queries = [];
  const pendingBatches = batches ? [...batches] : [events];
  const claims = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (claimError && sql.includes('RETURNING id, topic, payload, attempts')) throw claimError;
      if (sql.includes('RETURNING id, topic, payload, attempts')) {
        claims.push(params[0]);
        return { rows: pendingBatches.shift() || [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return {
    queries,
    claims,
    connect: async () => client,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rowCount: updateRowCount, rows: [] };
    },
  };
}

describe('OutboxPublisher', () => {
  it('claims and marks an event as published', async () => {
    const pool = createPool({ events: [{
      id: 'event-1', topic: 'topic', payload: { eventId: 'event-1' }, attempts: 1,
    }] });
    const published = [];
    const kafka = {
      isEnabled: () => true,
      isConnected: () => true,
      publishEvent: async (topic, payload) => published.push({ topic, payload }),
    };
    const publisher = new OutboxPublisher(pool, kafka);

    await expect(publisher.runOnce()).resolves.toBe(1);

    expect(published).toEqual([{ topic: 'topic', payload: { eventId: 'event-1' } }]);
    expect(pool.queries.some(({ sql }) => sql.includes("SET status = 'PUBLISHED'"))).toBe(true);
  });

  it('claimBatch pide el lote ordenado por fecha de creación (RETURNING no garantiza orden)', async () => {
    const pool = createPool();
    const publisher = new OutboxPublisher(pool, { isEnabled: () => true });

    await publisher.claimBatch();

    const claim = pool.queries.find(({ sql }) => sql.includes('RETURNING id, topic, payload, attempts'));
    expect(claim.sql.replace(/\s+/g, ' ').trim()).toMatch(/FROM claimed ORDER BY created_at, id$/);
  });

  it('un error transitorio nunca deja la fila FAILED, por más intentos que lleve (issue #104)', async () => {
    const pool = createPool();
    const publisher = new OutboxPublisher(pool, { isEnabled: () => true }, { maxBackoffMs: 900_000 });

    await publisher.markFailed('event-1', 50, new Error('broker down'));

    const failureQuery = pool.queries.at(-1);
    expect(failureQuery.params).toEqual(['event-1', 'PENDING', 900_000, 'broker down', 50]);
  });

  it('claimBatch hace ROLLBACK y repropaga si la query falla', async () => {
    const pool = createPool({ claimError: new Error('lock timeout') });
    const publisher = new OutboxPublisher(pool, { isEnabled: () => true });

    await expect(publisher.claimBatch()).rejects.toThrow('lock timeout');
    expect(pool.queries.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
  });

  it('runOnce marca failed y sigue si publishEvent lanza', async () => {
    const pool = createPool({ events: [{ id: 'event-2', topic: 'topic', payload: {}, attempts: 1 }] });
    const kafka = {
      isEnabled: () => true,
      isConnected: () => true,
      publishEvent: async () => { throw new Error('send failed'); },
    };
    const publisher = new OutboxPublisher(pool, kafka);

    const published = await publisher.runOnce();

    expect(published).toBe(0);
    expect(pool.queries.some(({ sql, params }) => sql.includes('SET status = $2') && params[0] === 'event-2')).toBe(true);
  });

  it('runOnce marca failed si publishEvent devuelve false (kafka deshabilitado dinámicamente)', async () => {
    const pool = createPool({ events: [{ id: 'event-3', topic: 'topic', payload: {}, attempts: 1 }] });
    const kafka = { isEnabled: () => true, isConnected: () => true, publishEvent: async () => false };
    const publisher = new OutboxPublisher(pool, kafka);

    const published = await publisher.runOnce();

    expect(published).toBe(0);
  });

  it('runOnce con kafka deshabilitado sale sin tocar la base (ni reclama ni purga)', async () => {
    const pool = createPool();
    const connect = jest.spyOn(pool, 'connect');
    const kafka = { isEnabled: () => false };
    const publisher = new OutboxPublisher(pool, kafka);

    const published = await publisher.runOnce();

    expect(published).toBe(0);
    expect(pool.queries).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
    expect(publisher.lastPollAt).toBeNull();
  });

  it('runOnce con el producer desconectado intenta reconectar y, si no puede, sale sin tocar la base', async () => {
    const pool = createPool({ events: [{ id: 'event-4', topic: 'topic', payload: {}, attempts: 1 }] });
    const kafka = {
      isEnabled: () => true,
      isConnected: () => false,
      connect: jest.fn().mockResolvedValue(false),
      publishEvent: jest.fn(),
    };
    const publisher = new OutboxPublisher(pool, kafka);

    await expect(publisher.runOnce()).resolves.toBe(0);

    expect(kafka.connect).toHaveBeenCalledTimes(1);
    expect(pool.queries).toHaveLength(0);
    expect(kafka.publishEvent).not.toHaveBeenCalled();
  });

  it('runOnce conecta el producer en el primer poll y publica si la conexión sale bien', async () => {
    const event = { id: 'event-5', topic: 'topic', payload: {}, attempts: 1 };
    const pool = createPool({ batches: [[event], [], [event]] });
    let connected = false;
    const kafka = {
      isEnabled: () => true,
      isConnected: () => connected,
      connect: jest.fn(async () => {
        connected = true;
        return true;
      }),
      publishEvent: jest.fn().mockResolvedValue(true),
    };
    const publisher = new OutboxPublisher(pool, kafka);

    await expect(publisher.runOnce()).resolves.toBe(1);
    await expect(publisher.runOnce()).resolves.toBe(1);

    expect(kafka.connect).toHaveBeenCalledTimes(1);
    expect(Date.parse(publisher.health().lastPollAt)).not.toBeNaN();
  });

  it('runOnce no purga: la purga va por su propio timer', async () => {
    const pool = createPool();
    const kafka = { isEnabled: () => true, isConnected: () => true };
    const publisher = new OutboxPublisher(pool, kafka);

    await publisher.runOnce();

    expect(pool.queries.some(({ sql }) => sql.includes('RETURNING id, topic, payload, attempts'))).toBe(true);
    expect(pool.queries.some(({ sql }) => sql.includes('DELETE FROM outbox_events'))).toBe(false);
  });

  it('start purga al arrancar y después una vez por hora (no en cada poll); stop corta los dos timers', async () => {
    jest.useFakeTimers();
    const pool = createPool();
    const publisher = new OutboxPublisher(pool, { isEnabled: () => false }, { intervalMs: 5000 });
    const purgeSpy = jest.spyOn(publisher, 'purgePublished');

    publisher.start();
    expect(purgeSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60 * 60 * 1000 - 1);
    expect(purgeSpy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(purgeSpy).toHaveBeenCalledTimes(2);

    publisher.stop();
    jest.advanceTimersByTime(3 * 60 * 60 * 1000);
    expect(purgeSpy).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('purgeExpired loguea el error sin relanzar', async () => {
    const pool = createPool();
    const publisher = new OutboxPublisher(pool, { isEnabled: () => false });
    jest.spyOn(publisher, 'purgePublished').mockRejectedValue(new Error('db down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(publisher.purgeExpired()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Outbox purge failed'));
    errorSpy.mockRestore();
  });

  it('health(): enabled solo mientras corre el poller', () => {
    jest.useFakeTimers();
    const publisher = new OutboxPublisher(createPool(), { isEnabled: () => false });
    expect(publisher.health()).toEqual({
      enabled: false, publisher: 'kafka', lastPollAt: null, pausedUntil: null, consecutiveFailures: 0,
    });
    const gateway = { isEnabled: () => true, publishEvent: async () => ({}) };
    expect(new OutboxPublisher(createPool(), {}, { publisher: gateway }).health().publisher).toBe('gateway');

    publisher.start();
    expect(publisher.health().enabled).toBe(true);

    publisher.stop();
    expect(publisher.health().enabled).toBe(false);
    jest.useRealTimers();
  });

  it('runOnce evita ejecuciones concurrentes (this.running)', async () => {
    const pool = createPool();
    const kafka = { isEnabled: () => false };
    const publisher = new OutboxPublisher(pool, kafka);
    publisher.running = true;

    await expect(publisher.runOnce()).resolves.toBe(0);
  });

  it('purgePublished devuelve el rowCount de la limpieza', async () => {
    const pool = createPool({ updateRowCount: 0 });
    const publisher = new OutboxPublisher(pool, { isEnabled: () => false });
    await expect(publisher.purgePublished()).resolves.toBe(0);
  });

  it('start corre runOnce inmediatamente y en cada intervalo; stop lo detiene', async () => {
    jest.useFakeTimers();
    const pool = createPool();
    const kafka = { isEnabled: () => false };
    const publisher = new OutboxPublisher(pool, kafka, { intervalMs: 1000 });
    const runOnceSpy = jest.spyOn(publisher, 'runOnce');

    publisher.start();
    await Promise.resolve();
    expect(runOnceSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(runOnceSpy).toHaveBeenCalledTimes(2);

    publisher.stop();
    jest.advanceTimersByTime(5000);
    expect(runOnceSpy).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('start registra el error si runOnce falla', async () => {
    jest.useFakeTimers();
    const pool = createPool();
    const publisher = new OutboxPublisher(pool, { isEnabled: () => false });
    jest.spyOn(publisher, 'runOnce').mockRejectedValue(new Error('boom'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    publisher.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Outbox poll failed'));

    publisher.stop();
    errorSpy.mockRestore();
    jest.useRealTimers();
  });

  // Issue #71: descartar PENDING previos al activar el bus.
  describe('publishSince (issue #71)', () => {
    it('resolvePublishSince devuelve null para vacio/undefined/null', () => {
      expect(resolvePublishSince(undefined)).toBeNull();
      expect(resolvePublishSince(null)).toBeNull();
      expect(resolvePublishSince('')).toBeNull();
    });

    it('resolvePublishSince parsea ISO 8601 y preserva Date valido', () => {
      const iso = '2026-11-02T00:00:00.000Z';
      expect(resolvePublishSince(iso)).toEqual(new Date(iso));
      const d = new Date('2026-11-02T12:00:00.000Z');
      expect(resolvePublishSince(d)).toBe(d);
    });

    it('resolvePublishSince lanza si el string no es parseable', () => {
      expect(() => resolvePublishSince('no-es-fecha')).toThrow(/OUTBOX_PUBLISH_SINCE/);
    });

    it('publishSince default es null (comportamiento previo intacto)', () => {
      const prev = process.env.OUTBOX_PUBLISH_SINCE;
      delete process.env.OUTBOX_PUBLISH_SINCE;
      try {
        const publisher = new OutboxPublisher(createPool(), { isEnabled: () => false });
        expect(publisher.publishSince).toBeNull();
      } finally {
        if (prev !== undefined) process.env.OUTBOX_PUBLISH_SINCE = prev;
      }
    });

    it('skipPendingBefore no corre query si publishSince es null', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => false });
      await expect(publisher.skipPendingBefore()).resolves.toBe(0);
      expect(pool.queries).toHaveLength(0);
    });

    it('skipPendingBefore marca PENDING < since como SKIPPED y devuelve rowCount', async () => {
      const since = new Date('2026-11-02T00:00:00.000Z');
      const pool = {
        queries: [],
        connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
        query: async function query(sql, params) {
          this.queries.push({ sql, params });
          if (sql.includes("SET status = 'SKIPPED'")) return { rowCount: 7 };
          return { rowCount: 0, rows: [] };
        },
      };
      const publisher = new OutboxPublisher(pool, { isEnabled: () => false }, { publishSince: since });

      await expect(publisher.skipPendingBefore()).resolves.toBe(7);

      const skipQ = pool.queries.find(({ sql }) => sql.includes("SET status = 'SKIPPED'"));
      expect(skipQ).toBeDefined();
      expect(skipQ.sql).toMatch(/status = 'PENDING' AND created_at < \$1/);
      expect(skipQ.params).toEqual([since.toISOString()]);
    });

    it('claimBatch pasa null como 2do param cuando no hay publishSince', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true });
      await publisher.claimBatch();
      const claimQ = pool.queries.find(({ sql }) => sql.includes('RETURNING id, topic, payload, attempts'));
      expect(claimQ.params[1]).toBeNull();
    });

    it('claimBatch pasa el ISO como 2do param cuando hay publishSince', async () => {
      const since = new Date('2026-11-02T00:00:00.000Z');
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true }, { publishSince: since });
      await publisher.claimBatch();
      const claimQ = pool.queries.find(({ sql }) => sql.includes('RETURNING id, topic, payload, attempts'));
      expect(claimQ.params[1]).toBe(since.toISOString());
      expect(claimQ.sql).toMatch(/created_at >= \$2::timestamptz/);
    });

    it('start corre skipPendingBefore antes de runOnce', async () => {
      jest.useFakeTimers();
      const since = new Date('2026-11-02T00:00:00.000Z');
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => false }, { publishSince: since });
      const skipSpy = jest.spyOn(publisher, 'skipPendingBefore').mockResolvedValue(0);
      const runOnceSpy = jest.spyOn(publisher, 'runOnce').mockResolvedValue(0);

      publisher.start();
      await Promise.resolve();
      await Promise.resolve();

      expect(skipSpy).toHaveBeenCalledTimes(1);
      expect(runOnceSpy).toHaveBeenCalledTimes(1);
      const skipOrder = skipSpy.mock.invocationCallOrder[0];
      const runOrder = runOnceSpy.mock.invocationCallOrder[0];
      expect(skipOrder).toBeLessThan(runOrder);

      publisher.stop();
      jest.useRealTimers();
    });
  });

  // Issue #74: publisher inyectado (GatewayPublisher) + clasificacion de errores.
  describe('publisher inyectado (issue #74)', () => {
    it('con el GatewayPublisher no conecta el producer de Kafka', async () => {
      const pool = createPool({ events: [{ id: 'e1', topic: 't', payload: { type: 'EmergenciaCreada' }, attempts: 1 }] });
      const kafka = { isEnabled: () => true, isConnected: jest.fn(() => false), connect: jest.fn(async () => false) };
      const gateway = { isEnabled: () => true, publishEvent: async () => ({ eventId: 'evt-gw-1', payloadHash: 'hash-1' }) };
      const publisher = new OutboxPublisher(pool, kafka, { publisher: gateway });

      await expect(publisher.runOnce()).resolves.toBe(1);

      expect(kafka.connect).not.toHaveBeenCalled();
    });

    it('con el GatewayPublisher apagado sale sin tocar la base', async () => {
      const pool = createPool({ events: [{ id: 'e1', topic: 't', payload: {}, attempts: 1 }] });
      const gateway = { isEnabled: () => false, publishEvent: jest.fn() };
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true }, { publisher: gateway });

      await expect(publisher.runOnce()).resolves.toBe(0);

      expect(pool.queries).toHaveLength(0);
      expect(gateway.publishEvent).not.toHaveBeenCalled();
    });

    it('usa options.publisher en vez de kafkaService cuando se inyecta', async () => {
      const pool = createPool({ events: [{ id: 'e1', topic: 't', payload: {}, attempts: 1 }] });
      const gatewayCalls = [];
      const gateway = {
        isEnabled: () => true,
        publishEvent: async (topic, payload) => {
          gatewayCalls.push({ topic, payload });
          return { eventId: 'evt-gw-1', payloadHash: 'hash-1' };
        },
      };
      const kafka = { isEnabled: () => false, publishEvent: async () => { throw new Error('no debe llamarse'); } };
      const publisher = new OutboxPublisher(pool, kafka, { publisher: gateway });

      await expect(publisher.runOnce()).resolves.toBe(1);

      expect(gatewayCalls).toHaveLength(1);
    });

    it('un evento que el publisher saltea queda SKIPPED y no cuenta como publicado', async () => {
      const pool = createPool({ events: [{ id: 'e1', topic: 't', payload: { type: 'EmergenciaPriorizada' }, attempts: 1 }] });
      const gateway = { isEnabled: () => true, publishEvent: async () => ({ skipped: true }) };
      const publisher = new OutboxPublisher(pool, {}, { publisher: gateway });

      await expect(publisher.runOnce()).resolves.toBe(0);

      const skipQ = pool.queries.find(({ sql }) => sql.includes("SET status = 'SKIPPED'"));
      expect(skipQ).toBeDefined();
      expect(skipQ.params).toEqual(['e1', 1]);
      expect(pool.queries.find(({ sql }) => sql.includes("SET status = 'PUBLISHED'"))).toBeUndefined();
    });

    it('markPublished escribe payload_hash y gateway_event_id cuando el publisher devuelve objeto', async () => {
      const pool = createPool({ events: [{ id: 'e1', topic: 't', payload: {}, attempts: 1 }] });
      const gateway = {
        isEnabled: () => true,
        publishEvent: async () => ({ eventId: 'evt-gw-1', payloadHash: 'hash-1' }),
      };
      const publisher = new OutboxPublisher(pool, {}, { publisher: gateway });

      await publisher.runOnce();

      const markQ = pool.queries.find(({ sql }) => sql.includes("SET status = 'PUBLISHED'"));
      expect(markQ).toBeDefined();
      expect(markQ.params).toEqual(['e1', 'hash-1', 'evt-gw-1', 1]);
    });

    it('markPublished deja payload_hash/gateway_event_id en NULL cuando el publisher devuelve true (KafkaService)', async () => {
      const pool = createPool({ events: [{ id: 'e2', topic: 't', payload: {}, attempts: 1 }] });
      const kafka = {
        isEnabled: () => true,
        isConnected: () => true,
        publishEvent: async () => true,
      };
      const publisher = new OutboxPublisher(pool, kafka);

      await publisher.runOnce();

      const markQ = pool.queries.find(({ sql }) => sql.includes("SET status = 'PUBLISHED'"));
      expect(markQ.params).toEqual(['e2', null, null, 1]);
    });

    it('markFailed con error.isPermanent → FAILED directo sin importar los attempts', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, {});
      const err = new Error('bad schema');
      err.isPermanent = true;

      await publisher.markFailed('e1', 1, err);

      const q = pool.queries.at(-1);
      expect(q.params[0]).toBe('e1');
      expect(q.params[1]).toBe('FAILED');
      expect(q.params[2]).toBe(0);
    });

    it('markFailed con error.retryAfterMs usa ese backoff en vez del exponencial', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, {});
      const err = new Error('rate limited');
      err.retryAfterMs = 45_000;

      await publisher.markFailed('e1', 1, err);

      const q = pool.queries.at(-1);
      expect(q.params[1]).toBe('PENDING');
      expect(q.params[2]).toBe(45_000);
    });

    it('markFailed con retryAfterMs > maxBackoffMs se capa al maximo', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, {}, { maxBackoffMs: 60_000 });
      const err = new Error('too long');
      err.retryAfterMs = 300_000;

      await publisher.markFailed('e1', 1, err);

      expect(pool.queries.at(-1).params[2]).toBe(60_000);
    });
  });
});

describe('isOutboxPublisherEnabled', () => {
  it('es opt-in: publica solo con OUTBOX_PUBLISHER_ENABLED=true', () => {
    expect(isOutboxPublisherEnabled({})).toBe(false);
    expect(isOutboxPublisherEnabled({ OUTBOX_PUBLISHER_ENABLED: 'false' })).toBe(false);
    expect(isOutboxPublisherEnabled({ OUTBOX_PUBLISHER_ENABLED: '1' })).toBe(false);
    expect(isOutboxPublisherEnabled({ OUTBOX_PUBLISHER_ENABLED: 'true' })).toBe(true);
  });

  describe('mark* solo actualiza si la fila sigue siendo de este reclamo', () => {
    const where = /WHERE id = \$1 AND status = 'PROCESSING' AND attempts = \$\d+$/;
    const lastSql = (pool) => pool.queries.at(-1).sql.replace(/\s+/g, ' ').trim();

    it.each([
      ['markPublished', (p) => p.markPublished('e1', 3, null), 'e1', 3],
      ['markSkipped', (p) => p.markSkipped('e1', 3), 'e1', 3],
      ['markFailed', (p) => p.markFailed('e1', 3, new Error('x')), 'e1', 3],
    ])('%s filtra por status PROCESSING y el attempts del reclamo', async (_name, call, id, attempts) => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, {});

      await expect(call(publisher)).resolves.toBe(true);

      expect(lastSql(pool)).toMatch(where);
      expect(pool.queries.at(-1).params[0]).toBe(id);
      expect(pool.queries.at(-1).params.at(-1)).toBe(attempts);
    });

    it('si otro proceso ya la reclamó (rowCount 0) no la pisa: devuelve false y loguea warn', async () => {
      const pool = createPool({ updateRowCount: 0 });
      const publisher = new OutboxPublisher(pool, {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(publisher.markFailed('e1', 1, new Error('timeout'))).resolves.toBe(false);
      await expect(publisher.markPublished('e1', 1)).resolves.toBe(false);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ya no es de este reclamo'));
      warnSpy.mockRestore();
    });
  });
});

// Issue #104: caídas largas del bus y orden por emergencia.
describe('OutboxPublisher ante caídas del bus (issue #104)', () => {
  const event = (id, emergenciaId, attempts = 1) => ({
    id, topic: 't', payload: { type: 'EmergenciaActualizada', data: { emergenciaId } }, attempts,
  });
  const transient = (message = 'Gateway 503') => new Error(message);
  const permanent = (message = 'Gateway 400') => Object.assign(new Error(message), { isPermanent: true });
  const updates = (pool, fragment) => pool.queries.filter(({ sql }) => sql.includes(fragment));

  function scriptedPublisher(script) {
    const sent = [];
    return {
      sent,
      isEnabled: () => true,
      publishEvent: async (topic, payload) => {
        sent.push(payload.data && payload.data.emergenciaId);
        const outcome = script.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome === undefined ? { eventId: null, payloadHash: null } : outcome;
      },
    };
  }

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('claimBatch', () => {
    it('no reclama un evento si hay uno anterior de la misma emergencia PENDING, PROCESSING o FAILED', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true });

      await publisher.claimBatch(7);

      const claim = pool.queries.find(({ sql }) => sql.includes('RETURNING id, topic, payload, attempts'));
      const sql = claim.sql.replace(/\s+/g, ' ');
      expect(sql).toContain("AND NOT EXISTS ( SELECT 1 FROM outbox_events prev WHERE prev.status IN ('PENDING', 'PROCESSING', 'FAILED')");
      expect(sql).toContain("COALESCE(prev.payload->'data'->>'emergenciaId', prev.payload->'data'->>'id') = COALESCE(o.payload->'data'->>'emergenciaId', o.payload->'data'->>'id')");
      expect(sql).toContain('(prev.created_at, prev.id) < (o.created_at, o.id)');
      // Los PENDING anteriores a publishSince no frenan: se descartan al arrancar.
      expect(sql).toContain("NOT (prev.status = 'PENDING' AND $2::timestamptz IS NOT NULL AND prev.created_at < $2::timestamptz)");
      expect(claim.params[0]).toBe(7);
    });

    it('sin límite explícito usa batchSize', async () => {
      const pool = createPool();
      await new OutboxPublisher(pool, { isEnabled: () => true }, { batchSize: 12 }).claimBatch();
      expect(pool.claims).toEqual([12]);
    });
  });

  describe('runOnce reclama de nuevo hasta batchSize', () => {
    it('publica en la misma corrida el evento siguiente de una emergencia cuando el anterior salió', async () => {
      const pool = createPool({ batches: [[event('a1', 'A'), event('b1', 'B')], [event('a2', 'A')]] });
      const gateway = scriptedPublisher([]);
      const publisher = new OutboxPublisher(pool, {}, { publisher: gateway });

      await expect(publisher.runOnce()).resolves.toBe(3);

      expect(gateway.sent).toEqual(['A', 'B', 'A']);
      // 50 → 48 → 47 y un último reclamo vacío que corta.
      expect(pool.claims).toEqual([50, 48, 47]);
    });

    it('no pasa de batchSize eventos por corrida', async () => {
      const pool = createPool({ batches: [[event('a1', 'A'), event('b1', 'B')], [event('a2', 'A')]] });
      const publisher = new OutboxPublisher(pool, {}, { publisher: scriptedPublisher([]), batchSize: 2 });

      await expect(publisher.runOnce()).resolves.toBe(2);

      expect(pool.claims).toEqual([2]);
    });
  });

  describe('error transitorio: corta el lote y pausa', () => {
    it('el primer error transitorio deja la fila PENDING con backoff, devuelve el resto sin gastar intentos y no manda más', async () => {
      let now = 1_000_000;
      const pool = createPool({ batches: [[event('a1', 'A', 3), event('b1', 'B', 1), event('c1', 'C', 2)]] });
      const gateway = scriptedPublisher([transient()]);
      const publisher = new OutboxPublisher(pool, {}, { publisher: gateway, intervalMs: 5000, now: () => now });

      await expect(publisher.runOnce()).resolves.toBe(0);

      expect(gateway.sent).toEqual(['A']);
      const [failed] = updates(pool, 'SET status = $2');
      expect(failed.params.slice(0, 2)).toEqual(['a1', 'PENDING']);
      const [release] = updates(pool, 'FROM unnest($1::uuid[], $2::int[]) AS claim(id, attempts)');
      expect(release.sql).toMatch(/attempts = o\.attempts - 1/);
      expect(release.sql).toMatch(/o\.status = 'PROCESSING' AND o\.attempts = claim\.attempts/);
      expect(release.params).toEqual([['b1', 'c1'], [1, 2]]);
      // Corta: no vuelve a reclamar en esta corrida.
      expect(pool.claims).toHaveLength(1);
      expect(publisher.health()).toMatchObject({
        pausedUntil: new Date(1_005_000).toISOString(),
        consecutiveFailures: 1,
      });

      // En pausa no toca la base.
      const before = pool.queries.length;
      now += 4999;
      await expect(publisher.runOnce()).resolves.toBe(0);
      expect(pool.queries).toHaveLength(before);

      // Pasada la pausa vuelve a reclamar.
      now += 1;
      await publisher.runOnce();
      expect(pool.claims).toHaveLength(2);
    });

    it('la pausa se duplica con cada fallo seguido, hasta maxPauseMs', () => {
      const now = 0;
      const publisher = new OutboxPublisher(createPool(), {}, {
        publisher: scriptedPublisher([]), intervalMs: 5000, maxPauseMs: 30_000, now: () => now,
      });
      const pauses = [];
      for (let i = 0; i < 5; i += 1) {
        publisher.pause(transient());
        pauses.push(publisher.pausedUntil - now);
      }
      expect(pauses).toEqual([5000, 10_000, 20_000, 30_000, 30_000]);
    });

    it('un 429 con Retry-After pausa ese tiempo, acotado a maxBackoffMs', () => {
      const publisher = new OutboxPublisher(createPool(), {}, {
        publisher: scriptedPublisher([]), maxBackoffMs: 60_000, now: () => 0,
      });

      publisher.pause(Object.assign(transient('Gateway 429'), { retryAfterMs: 20_000 }));
      expect(publisher.pausedUntil).toBe(20_000);

      publisher.pause(Object.assign(transient('Gateway 429'), { retryAfterMs: 600_000 }));
      expect(publisher.pausedUntil).toBe(60_000);
    });

    it('la pausa por defecto no pasa de 5 minutos ni de maxBackoffMs', () => {
      expect(new OutboxPublisher(createPool(), {}).maxPauseMs).toBe(5 * 60 * 1000);
      expect(new OutboxPublisher(createPool(), {}, { maxBackoffMs: 60_000 }).maxPauseMs).toBe(60_000);
    });

    it('un envío que sale bien levanta la pausa y reinicia la cuenta', async () => {
      const now = 0;
      const pool = createPool({ batches: [[event('a1', 'A')]] });
      const publisher = new OutboxPublisher(pool, {}, { publisher: scriptedPublisher([]), now: () => now });
      publisher.consecutiveFailures = 4;
      publisher.pausedUntil = -1;

      await expect(publisher.runOnce()).resolves.toBe(1);

      expect(publisher.health()).toMatchObject({ pausedUntil: null, consecutiveFailures: 0 });
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('volvió a responder'));
    });

    it('un evento salteado (no pasa por el bus) no levanta la pausa', async () => {
      const pool = createPool({ batches: [[event('p1', 'A')]] });
      const publisher = new OutboxPublisher(pool, {}, { publisher: scriptedPublisher([{ skipped: true }]), now: () => 0 });
      publisher.consecutiveFailures = 2;
      publisher.pausedUntil = -1;

      await publisher.runOnce();

      expect(publisher.consecutiveFailures).toBe(2);
    });

    it('un error permanente marca FAILED pero no corta el lote ni pausa', async () => {
      const pool = createPool({ batches: [[event('a1', 'A'), event('b1', 'B')]] });
      const gateway = scriptedPublisher([permanent()]);
      const publisher = new OutboxPublisher(pool, {}, { publisher: gateway });

      await expect(publisher.runOnce()).resolves.toBe(1);

      expect(gateway.sent).toEqual(['A', 'B']);
      expect(updates(pool, 'SET status = $2')[0].params.slice(0, 2)).toEqual(['a1', 'FAILED']);
      expect(updates(pool, 'FROM unnest(')).toHaveLength(0);
      expect(publisher.isPaused()).toBe(false);
    });

    it('si el error es del último del lote no hay nada que devolver', async () => {
      const pool = createPool({ batches: [[event('a1', 'A')]] });
      const publisher = new OutboxPublisher(pool, {}, { publisher: scriptedPublisher([transient()]) });

      await publisher.runOnce();

      expect(updates(pool, 'FROM unnest(')).toHaveLength(0);
      expect(publisher.isPaused()).toBe(true);
    });

    it('releaseClaims devuelve 0 si la base no informa filas', async () => {
      const pool = createPool();
      pool.query = async () => ({ rows: [] });
      const publisher = new OutboxPublisher(pool, {});

      await expect(publisher.releaseClaims([event('a1', 'A')])).resolves.toBe(0);
    });
  });

  describe('configuración por entorno', () => {
    const saved = {};
    beforeEach(() => {
      ['OUTBOX_BATCH_SIZE', 'OUTBOX_POLL_INTERVAL_MS'].forEach((name) => {
        saved[name] = process.env[name];
      });
    });
    afterEach(() => {
      Object.entries(saved).forEach(([name, value]) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    });

    it('OUTBOX_BATCH_SIZE y OUTBOX_POLL_INTERVAL_MS cambian el lote y el intervalo', () => {
      process.env.OUTBOX_BATCH_SIZE = '10';
      process.env.OUTBOX_POLL_INTERVAL_MS = '15000';
      const publisher = new OutboxPublisher(createPool(), {});
      expect(publisher.batchSize).toBe(10);
      expect(publisher.intervalMs).toBe(15_000);
    });

    it.each([['0'], ['-5'], ['abc'], [''], ['10.5']])('un valor inválido (%p) cae al default', (value) => {
      process.env.OUTBOX_BATCH_SIZE = value;
      process.env.OUTBOX_POLL_INTERVAL_MS = value;
      const publisher = new OutboxPublisher(createPool(), {});
      expect(publisher.batchSize).toBe(50);
      expect(publisher.intervalMs).toBe(5000);
    });
  });
});
