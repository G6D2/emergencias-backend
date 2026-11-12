const { OutboxPublisher, resolvePublishSince, isOutboxPublisherEnabled } = require('../services/outbox-publisher');

function createPool({ events = [], claimError = null } = {}) {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (claimError && sql.includes('RETURNING id, topic, payload, attempts')) throw claimError;
      if (sql.includes('RETURNING id, topic, payload, attempts')) return { rows: events };
      return { rows: [] };
    },
    release: () => {},
  };
  return {
    queries,
    connect: async () => client,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rowCount: 0, rows: [] };
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
    const publisher = new OutboxPublisher(pool, kafka, { maxAttempts: 3 });

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

  it('marks a repeatedly failing event as FAILED after max attempts', async () => {
    const pool = createPool();
    const publisher = new OutboxPublisher(pool, { isEnabled: () => true }, { maxAttempts: 2 });

    await publisher.markFailed('event-1', 2, new Error('broker down'));

    const failureQuery = pool.queries.at(-1);
    expect(failureQuery.params).toEqual(['event-1', 'FAILED', 0, 'broker down']);
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
    const publisher = new OutboxPublisher(pool, kafka, { maxAttempts: 3 });

    const published = await publisher.runOnce();

    expect(published).toBe(0);
    expect(pool.queries.some(({ sql, params }) => sql.includes('SET status = $2') && params[0] === 'event-2')).toBe(true);
  });

  it('runOnce marca failed si publishEvent devuelve false (kafka deshabilitado dinámicamente)', async () => {
    const pool = createPool({ events: [{ id: 'event-3', topic: 'topic', payload: {}, attempts: 1 }] });
    const kafka = { isEnabled: () => true, isConnected: () => true, publishEvent: async () => false };
    const publisher = new OutboxPublisher(pool, kafka, { maxAttempts: 3 });

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
    const pool = createPool({ events: [{ id: 'event-5', topic: 'topic', payload: {}, attempts: 1 }] });
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
    expect(publisher.health()).toEqual({ enabled: false, publisher: 'kafka', lastPollAt: null });
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
    const pool = createPool();
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
      expect(skipQ.params).toEqual(['e1']);
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
      expect(markQ.params).toEqual(['e1', 'hash-1', 'evt-gw-1']);
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
      expect(markQ.params).toEqual(['e2', null, null]);
    });

    it('markFailed con error.isPermanent → FAILED directo sin importar los attempts', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, {}, { maxAttempts: 10 });
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
      const publisher = new OutboxPublisher(pool, {}, { maxAttempts: 10 });
      const err = new Error('rate limited');
      err.retryAfterMs = 45_000;

      await publisher.markFailed('e1', 1, err);

      const q = pool.queries.at(-1);
      expect(q.params[1]).toBe('PENDING');
      expect(q.params[2]).toBe(45_000);
    });

    it('markFailed con retryAfterMs > maxBackoffMs se capa al maximo', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, {}, { maxAttempts: 10, maxBackoffMs: 60_000 });
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
});
