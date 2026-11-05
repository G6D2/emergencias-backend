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
});

describe('isOutboxPublisherEnabled', () => {
  it('publica por default y se apaga solo con OUTBOX_PUBLISHER_ENABLED=false', () => {
    expect(isOutboxPublisherEnabled({})).toBe(true);
    expect(isOutboxPublisherEnabled({ OUTBOX_PUBLISHER_ENABLED: 'true' })).toBe(true);
    expect(isOutboxPublisherEnabled({ OUTBOX_PUBLISHER_ENABLED: 'false' })).toBe(false);
  });
});
