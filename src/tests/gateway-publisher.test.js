const { GatewayPublisher, PermanentError } = require('../services/gateway-publisher');

function createAuthClient(tokens = ['tok-1', 'tok-2']) {
  let idx = 0;
  const invalidations = [];
  return {
    getToken: jest.fn(async () => tokens[Math.min(idx, tokens.length - 1)]),
    invalidate: jest.fn(() => { idx += 1; invalidations.push(Date.now()); }),
    invalidations,
  };
}

function mockFetch({ status, body = '{}', retryAfter = null, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => (body ? JSON.parse(body) : {}),
      text: async () => body,
      headers: {
        get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null),
      },
    };
  };
}

describe('GatewayPublisher (issue #74)', () => {
  const BASE_URL = 'https://gateway.example';
  const TOPIC = 'com.citypass.emergencias.EmergenciaCreada';
  const PAYLOAD = { metadata: { type: 'EmergenciaCreada' }, data: { emergenciaId: 'em-1' } };

  describe('isEnabled', () => {
    const prev = process.env.EDA_PUBLISHER_MODE;
    afterEach(() => {
      if (prev === undefined) delete process.env.EDA_PUBLISHER_MODE;
      else process.env.EDA_PUBLISHER_MODE = prev;
    });

    it('true solo con EDA_PUBLISHER_MODE=gateway', () => {
      const pub = new GatewayPublisher(createAuthClient(), { baseUrl: BASE_URL, fetch: async () => {} });
      process.env.EDA_PUBLISHER_MODE = 'gateway';
      expect(pub.isEnabled()).toBe(true);
      process.env.EDA_PUBLISHER_MODE = 'kafka';
      expect(pub.isEnabled()).toBe(false);
      delete process.env.EDA_PUBLISHER_MODE;
      expect(pub.isEnabled()).toBe(false);
    });
  });

  describe('publishEvent — happy path', () => {
    it('POST a ${baseUrl}/events/${topic} con Bearer y JSON body', async () => {
      const calls = [];
      const auth = createAuthClient();
      const pub = new GatewayPublisher(auth, {
        baseUrl: BASE_URL,
        fetch: mockFetch({ status: 202, body: '{"eventId":"evt-gw-1","payloadHash":"abc123"}', calls }),
      });

      const result = await pub.publishEvent(TOPIC, PAYLOAD);

      expect(auth.getToken).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE_URL}/events/${encodeURIComponent(TOPIC)}`);
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.headers.Authorization).toBe('Bearer tok-1');
      expect(calls[0].init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(calls[0].init.body)).toEqual(PAYLOAD);
      expect(result).toEqual({ eventId: 'evt-gw-1', payloadHash: 'abc123' });
    });

    it('2xx sin body devuelve { eventId: null, payloadHash: null }', async () => {
      const auth = createAuthClient();
      const pub = new GatewayPublisher(auth, {
        baseUrl: BASE_URL,
        fetch: async () => ({
          status: 204, ok: true,
          json: async () => { throw new Error('no body'); },
          text: async () => '',
          headers: { get: () => null },
        }),
      });

      const result = await pub.publishEvent(TOPIC, PAYLOAD);
      expect(result).toEqual({ eventId: null, payloadHash: null });
    });

    it('baseUrl con trailing slash se normaliza', async () => {
      const calls = [];
      const pub = new GatewayPublisher(createAuthClient(), {
        baseUrl: `${BASE_URL}/`,
        fetch: mockFetch({ status: 202, body: '{}', calls }),
      });
      await pub.publishEvent(TOPIC, PAYLOAD);
      expect(calls[0].url).toBe(`${BASE_URL}/events/${encodeURIComponent(TOPIC)}`);
    });
  });

  describe('publishEvent — autenticacion', () => {
    it('401 invalida el token y reintenta UNA vez con token fresco', async () => {
      const calls = [];
      let callNum = 0;
      const auth = createAuthClient(['tok-stale', 'tok-fresh']);
      const pub = new GatewayPublisher(auth, {
        baseUrl: BASE_URL,
        fetch: async (url, init) => {
          calls.push({ url, init });
          callNum += 1;
          if (callNum === 1) {
            return {
              status: 401, ok: false,
              json: async () => ({}), text: async () => 'token expired',
              headers: { get: () => null },
            };
          }
          return {
            status: 202, ok: true,
            json: async () => ({ eventId: 'evt-gw-2' }), text: async () => '',
            headers: { get: () => null },
          };
        },
      });

      const result = await pub.publishEvent(TOPIC, PAYLOAD);

      expect(auth.invalidate).toHaveBeenCalledTimes(1);
      expect(auth.getToken).toHaveBeenCalledTimes(2);
      expect(calls).toHaveLength(2);
      expect(calls[0].init.headers.Authorization).toBe('Bearer tok-stale');
      expect(calls[1].init.headers.Authorization).toBe('Bearer tok-fresh');
      expect(result.eventId).toBe('evt-gw-2');
    });

    it('401 persistente tras reintento lanza PermanentError (no reintentar via outbox)', async () => {
      const auth = createAuthClient();
      const pub = new GatewayPublisher(auth, {
        baseUrl: BASE_URL,
        fetch: mockFetch({ status: 401, body: 'still unauthorized' }),
      });

      await expect(pub.publishEvent(TOPIC, PAYLOAD)).rejects.toMatchObject({
        isPermanent: true,
        message: expect.stringContaining('401 tras reintento'),
      });
    });
  });

  describe('publishEvent — clasificacion de errores', () => {
    it('400 lanza PermanentError', async () => {
      const pub = new GatewayPublisher(createAuthClient(), {
        baseUrl: BASE_URL,
        fetch: mockFetch({ status: 400, body: 'schema mismatch' }),
      });
      const err = await pub.publishEvent(TOPIC, PAYLOAD).catch((e) => e);
      expect(err).toBeInstanceOf(PermanentError);
      expect(err.isPermanent).toBe(true);
      expect(err.message).toMatch(/400.*schema mismatch/);
    });

    it('404 y 413 tambien son permanentes', async () => {
      for (const status of [404, 413]) {
        const pub = new GatewayPublisher(createAuthClient(), {
          baseUrl: BASE_URL,
          fetch: mockFetch({ status, body: 'nope' }),
        });
        await expect(pub.publishEvent(TOPIC, PAYLOAD)).rejects.toMatchObject({ isPermanent: true });
      }
    });

    it('429 incluye retryAfterMs cuando el header esta presente', async () => {
      const pub = new GatewayPublisher(createAuthClient(), {
        baseUrl: BASE_URL,
        fetch: mockFetch({ status: 429, body: 'slow down', retryAfter: '30' }),
      });
      const err = await pub.publishEvent(TOPIC, PAYLOAD).catch((e) => e);
      expect(err.isPermanent).toBeFalsy();
      expect(err.retryAfterMs).toBe(30_000);
    });

    it('429 sin Retry-After deja retryAfterMs=null (outbox usa backoff propio)', async () => {
      const pub = new GatewayPublisher(createAuthClient(), {
        baseUrl: BASE_URL,
        fetch: mockFetch({ status: 429, body: 'slow down', retryAfter: null }),
      });
      const err = await pub.publishEvent(TOPIC, PAYLOAD).catch((e) => e);
      expect(err.retryAfterMs).toBeNull();
    });

    it('500 es transient (sin isPermanent), outbox reintenta', async () => {
      const pub = new GatewayPublisher(createAuthClient(), {
        baseUrl: BASE_URL,
        fetch: mockFetch({ status: 500, body: 'internal' }),
      });
      const err = await pub.publishEvent(TOPIC, PAYLOAD).catch((e) => e);
      expect(err.isPermanent).toBeFalsy();
      expect(err.retryAfterMs).toBeUndefined();
      expect(err.message).toMatch(/500.*internal/);
    });
  });

  describe('publishEvent — configuracion', () => {
    it('sin baseUrl lanza al publicar', async () => {
      const pub = new GatewayPublisher(createAuthClient(), { fetch: async () => {} });
      pub.baseUrl = null;
      await expect(pub.publishEvent(TOPIC, PAYLOAD)).rejects.toThrow(/EDA_API_URL no configurado/);
    });
  });
});
