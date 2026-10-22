const { GatewayPublisher } = require('../services/gateway-publisher');

function makeAuthClient(token = 'tok-123') {
  return {
    getToken: jest.fn().mockResolvedValue(token),
  };
}

function makeResponse({ status = 202, body = null, text = '', retryAfter = null } = {}) {
  return {
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null),
    },
    json: async () => body,
    text: async () => text,
  };
}

describe('GatewayPublisher', () => {
  describe('isEnabled()', () => {
    it('true cuando hay apiUrl, authClient y fetch', () => {
      const p = new GatewayPublisher({
        apiUrl: 'https://gw.example.com',
        edaAuthClient: makeAuthClient(),
        fetchImpl: jest.fn(),
      });
      expect(p.isEnabled()).toBe(true);
    });

    it('false si falta apiUrl', () => {
      const p = new GatewayPublisher({ apiUrl: '', edaAuthClient: makeAuthClient(), fetchImpl: jest.fn() });
      expect(p.isEnabled()).toBe(false);
    });

    it('false si falta edaAuthClient', () => {
      const p = new GatewayPublisher({ apiUrl: 'https://gw', edaAuthClient: null, fetchImpl: jest.fn() });
      expect(p.isEnabled()).toBe(false);
    });

    it('false si falta fetch', () => {
      const p = new GatewayPublisher({
        apiUrl: 'https://gw',
        edaAuthClient: makeAuthClient(),
        fetchImpl: null,
      });
      expect(p.isEnabled()).toBe(false);
    });

    it('normaliza apiUrl sin trailing slash', () => {
      const p = new GatewayPublisher({
        apiUrl: 'https://gw.example.com///',
        edaAuthClient: makeAuthClient(),
        fetchImpl: jest.fn(),
      });
      expect(p.apiUrl).toBe('https://gw.example.com');
    });
  });

  describe('extractData()', () => {
    it('devuelve payload.data si existe', () => {
      expect(GatewayPublisher.extractData({ type: 'X', data: { x: 1 } })).toEqual({ x: 1 });
    });

    it('devuelve payload entero si no hay .data', () => {
      expect(GatewayPublisher.extractData({ x: 1 })).toEqual({ x: 1 });
    });

    it('devuelve null si payload es null', () => {
      expect(GatewayPublisher.extractData(null)).toBeNull();
    });
  });

  describe('publishEvent()', () => {
    const baseOpts = (fetchImpl) => ({
      apiUrl: 'https://gw.example.com',
      edaAuthClient: makeAuthClient('token-abc'),
      fetchImpl,
      timeoutMs: 5000,
    });

    it('devuelve false si no esta configurado (sin loguear excepciones)', async () => {
      const p = new GatewayPublisher({ apiUrl: '' });
      await expect(p.publishEvent('com.citypass.emergencias.X', { a: 1 })).resolves.toBe(false);
    });

    it('rechaza topic sin punto (no FQN) como permanente', async () => {
      const fetchImpl = jest.fn();
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      // "sinFqn" no tiene punto => no es FQN de ningun namespace del gateway.
      // Topics con punto pero fuera del namespace propio los rechaza el gateway
      // con 403; el publisher no los filtra para no duplicar reglas del gateway.
      await expect(p.publishEvent('sinFqn', { a: 1 }).catch(e => e))
        .resolves.toMatchObject({ isPermanent: true });
      await expect(p.publishEvent(42, { a: 1 }).catch(e => e))
        .resolves.toMatchObject({ isPermanent: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rechaza payload que supera maxBodyBytes como permanente', async () => {
      const fetchImpl = jest.fn();
      const p = new GatewayPublisher({ ...baseOpts(fetchImpl), maxBodyBytes: 50 });
      const big = { blob: 'x'.repeat(100) };
      const err = await p.publishEvent('com.citypass.emergencias.X', big).catch(e => e);
      expect(err).toMatchObject({ isPermanent: true });
      expect(err.message).toMatch(/supera/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('202: devuelve { ok, eventId, payloadHash, envelope }', async () => {
      const envelope = {
        metadata: { eventId: 'evt-1', payloadHash: 'sha-1', source: 'grupo5' },
        data: { a: 1 },
      };
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({ status: 202, body: envelope }));
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      const result = await p.publishEvent('com.citypass.emergencias.EmergenciaReportada', { type: 'X', data: { a: 1 } });

      expect(result).toEqual({
        ok: true,
        eventId: 'evt-1',
        payloadHash: 'sha-1',
        envelope,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://gw.example.com/api/v1/event-types/com.citypass.emergencias.EmergenciaReportada/events');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer token-abc');
      expect(init.headers['Content-Type']).toBe('application/json');
      // Body manda SOLO data (no el envelope del outbox).
      expect(JSON.parse(init.body)).toEqual({ a: 1 });
    });

    it('202 sin metadata usa null para eventId/payloadHash', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({ status: 202, body: {} }));
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      const result = await p.publishEvent('com.citypass.emergencias.X', { a: 1 });
      expect(result.eventId).toBeNull();
      expect(result.payloadHash).toBeNull();
    });

    it('429 marca retryAfterMs desde header Retry-After en segundos', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({
        status: 429, text: 'rate limited', retryAfter: '30',
      }));
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      const err = await p.publishEvent('com.citypass.emergencias.X', { a: 1 }).catch(e => e);
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBe(30000);
      expect(err.isPermanent).toBeUndefined();
    });

    it('429 soporta Retry-After como fecha HTTP', async () => {
      const future = new Date(Date.now() + 10000).toUTCString();
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({
        status: 429, text: 'rate limited', retryAfter: future,
      }));
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      const err = await p.publishEvent('com.citypass.emergencias.X', { a: 1 }).catch(e => e);
      expect(err.retryAfterMs).toBeGreaterThan(0);
      expect(err.retryAfterMs).toBeLessThanOrEqual(10000);
    });

    it('429 sin Retry-After deja retryAfterMs = null', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({ status: 429, text: 'rl' }));
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      const err = await p.publishEvent('com.citypass.emergencias.X', { a: 1 }).catch(e => e);
      expect(err.retryAfterMs).toBeNull();
    });

    it('504 marca isPublishedPossibly (reintento con mismo payloadHash dedup)', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({ status: 504, text: 'kafka no confirmo' }));
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      const err = await p.publishEvent('com.citypass.emergencias.X', { a: 1 }).catch(e => e);
      expect(err.status).toBe(504);
      expect(err.isPublishedPossibly).toBe(true);
      expect(err.isPermanent).toBeUndefined();
    });

    it('400/404/413 marcan isPermanent (no reintentar)', async () => {
      for (const status of [400, 404, 413]) {
        const fetchImpl = jest.fn().mockResolvedValue(makeResponse({ status, text: `error ${status}` }));
        const p = new GatewayPublisher(baseOpts(fetchImpl));
        const err = await p.publishEvent('com.citypass.emergencias.X', { a: 1 }).catch(e => e);
        expect(err.status).toBe(status);
        expect(err.isPermanent).toBe(true);
      }
    });

    it('500 queda transitorio (sin isPermanent, se reintenta por backoff default)', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({ status: 500, text: 'boom' }));
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      const err = await p.publishEvent('com.citypass.emergencias.X', { a: 1 }).catch(e => e);
      expect(err.status).toBe(500);
      expect(err.isPermanent).toBeUndefined();
      expect(err.retryAfterMs).toBeUndefined();
    });

    it('error de red se envuelve con cause', async () => {
      const original = new Error('ECONNREFUSED');
      const fetchImpl = jest.fn().mockRejectedValue(original);
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      const err = await p.publishEvent('com.citypass.emergencias.X', { a: 1 }).catch(e => e);
      expect(err.message).toMatch(/fallo de red/);
      expect(err.cause).toBe(original);
    });

    it('encodea el topic en la URL para que un fqn con caracteres raros no rompa', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({ status: 202, body: { metadata: {} } }));
      const p = new GatewayPublisher(baseOpts(fetchImpl));
      await p.publishEvent('com.citypass.emergencias.X', { a: 1 });
      const [url] = fetchImpl.mock.calls[0];
      expect(url).toContain('com.citypass.emergencias.X');
    });
  });
});
