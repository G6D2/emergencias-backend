const { OutboxPublisher } = require('../services/outbox-publisher');

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
      publishEvent: async (topic, payload) => published.push({ topic, payload }),
    };
    const publisher = new OutboxPublisher(pool, kafka, { maxAttempts: 3 });

    await expect(publisher.runOnce()).resolves.toBe(1);

    expect(published).toEqual([{ topic: 'topic', payload: { eventId: 'event-1' } }]);
    expect(pool.queries.some(({ sql }) => sql.includes("SET status = 'PUBLISHED'"))).toBe(true);
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

  it('runOnce marca failed y sigue si publishEvent lanza, y no reclama nada si kafka está deshabilitado', async () => {
    const pool = createPool({ events: [{ id: 'event-2', topic: 'topic', payload: {}, attempts: 1 }] });
    const kafka = {
      isEnabled: () => true,
      publishEvent: async () => { throw new Error('send failed'); },
    };
    const publisher = new OutboxPublisher(pool, kafka, { maxAttempts: 3 });

    const published = await publisher.runOnce();

    expect(published).toBe(0);
    expect(pool.queries.some(({ sql, params }) => sql.includes('SET status = $2') && params[0] === 'event-2')).toBe(true);
  });

  it('runOnce marca failed si publishEvent devuelve false (kafka deshabilitado dinámicamente)', async () => {
    const pool = createPool({ events: [{ id: 'event-3', topic: 'topic', payload: {}, attempts: 1 }] });
    const kafka = { isEnabled: () => true, publishEvent: async () => false };
    const publisher = new OutboxPublisher(pool, kafka, { maxAttempts: 3 });

    const published = await publisher.runOnce();

    expect(published).toBe(0);
  });

  it('runOnce no reclama batch si kafka está deshabilitado, pero sí purga', async () => {
    const pool = createPool();
    const kafka = { isEnabled: () => false };
    const publisher = new OutboxPublisher(pool, kafka);

    const published = await publisher.runOnce();

    expect(published).toBe(0);
    expect(pool.queries.some(({ sql }) => sql.includes('RETURNING id, topic, payload, attempts'))).toBe(false);
    expect(pool.queries.some(({ sql }) => sql.includes('DELETE FROM outbox_events'))).toBe(true);
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

  describe('publisher inyectado (feature flag EDA_PUBLISHER_MODE=gateway)', () => {
    it('runOnce usa options.publisher en vez de kafkaService', async () => {
      const pool = createPool({ events: [{
        id: 'event-10', topic: 'com.citypass.emergencias.X', payload: { data: { a: 1 } }, attempts: 1,
      }] });
      const kafkaSpy = { isEnabled: jest.fn().mockReturnValue(false), publishEvent: jest.fn() };
      const gateway = {
        isEnabled: jest.fn().mockReturnValue(true),
        publishEvent: jest.fn().mockResolvedValue({ ok: true, eventId: '11111111-1111-4111-8111-111111111111', payloadHash: 'sha-xyz' }),
      };
      const publisher = new OutboxPublisher(pool, kafkaSpy, { publisher: gateway, maxAttempts: 3 });

      await expect(publisher.runOnce()).resolves.toBe(1);
      expect(gateway.publishEvent).toHaveBeenCalledWith('com.citypass.emergencias.X', { data: { a: 1 } });
      expect(kafkaSpy.publishEvent).not.toHaveBeenCalled();
    });

    it('markPublished persiste payloadHash y gatewayEventId cuando el publisher devuelve objeto', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true });
      await publisher.markPublished('event-x', { ok: true, eventId: '11111111-1111-4111-8111-111111111111', payloadHash: 'sha-abc' });

      const call = pool.queries.at(-1);
      expect(call.sql).toMatch(/payload_hash = COALESCE/);
      expect(call.sql).toMatch(/gateway_event_id = COALESCE/);
      expect(call.params).toEqual(['event-x', 'sha-abc', '11111111-1111-4111-8111-111111111111']);
    });

    it('markPublished sin result deja payloadHash y gatewayEventId en NULL (backward compat Kafka)', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true });
      await publisher.markPublished('event-y');
      const call = pool.queries.at(-1);
      expect(call.params).toEqual(['event-y', null, null]);
    });

    it('markFailed honra error.retryAfterMs en vez del backoff exponencial', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true }, { maxAttempts: 10 });

      const err = new Error('rate limited');
      err.retryAfterMs = 7500;
      await publisher.markFailed('event-r', 1, err);

      const call = pool.queries.at(-1);
      expect(call.params).toEqual(['event-r', 'PENDING', 7500, 'rate limited']);
    });

    it('markFailed con isPermanent marca FAILED inmediato aunque queden intentos', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true }, { maxAttempts: 10 });

      const err = new Error('schema invalid');
      err.isPermanent = true;
      await publisher.markFailed('event-p', 1, err);

      const call = pool.queries.at(-1);
      expect(call.params).toEqual(['event-p', 'FAILED', 0, 'schema invalid']);
    });

    it('markFailed cap-ea retryAfterMs al maxBackoffMs', async () => {
      const pool = createPool();
      const publisher = new OutboxPublisher(pool, { isEnabled: () => true }, {
        maxAttempts: 10,
        maxBackoffMs: 5000,
      });

      const err = new Error('rate limited');
      err.retryAfterMs = 999999;
      await publisher.markFailed('event-cap', 1, err);

      const call = pool.queries.at(-1);
      expect(call.params[2]).toBe(5000);
    });
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
});