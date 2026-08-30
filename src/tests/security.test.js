const { createLocationCrypto } = require('../security/location-crypto');
const { redactObject, summarizeEventForLog } = require('../security/secure-log');
const { createSecurityMiddleware } = require('../security/security-headers');
const { startLocationRetentionJob } = require('../security/location-retention');

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

describe('location-crypto', () => {
  const cryptoApi = createLocationCrypto(TEST_KEY);

  it('round-trips latitude/longitude', () => {
    const ciphertext = cryptoApi.encryptLocation({
      latitude: -34.6037,
      longitude: -58.3816,
    });

    expect(typeof ciphertext).toBe('string');
    expect(ciphertext).not.toContain('34.6037');

    const plain = cryptoApi.decryptLocation(ciphertext);
    expect(plain.latitude).toBeCloseTo(-34.6037);
    expect(plain.longitude).toBeCloseTo(-58.3816);
  });

  it('rejects invalid key length', () => {
    expect(() => createLocationCrypto(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('secure-log', () => {
  it('redacts location and authorization fields', () => {
    const redacted = redactObject({
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
      latitude: -34.6,
      longitude: -58.4,
      emergencyId: 'abc',
      nested: { access_token: 'secret', ok: true },
    });

    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted.latitude).toBe('[REDACTED]');
    expect(redacted.longitude).toBe('[REDACTED]');
    expect(redacted.emergencyId).toBe('abc');
    expect(redacted.nested.access_token).toBe('[REDACTED]');
    expect(redacted.nested.ok).toBe(true);
  });

  it('summarizes kafka events without coordinates', () => {
    const summary = summarizeEventForLog('emergencias.boton-panico', {
      id: 'e1',
      userId: 'U1',
      status: 'CREATED',
      latitude: -34.6,
      longitude: -58.4,
    });

    expect(summary).toEqual({
      topic: 'emergencias.boton-panico',
      type: undefined,
      emergencyId: 'e1',
      status: 'CREATED',
      userId: 'U1',
      actor: undefined,
      hasLocation: true,
    });
    expect(summary.latitude).toBeUndefined();
  });
});

describe('security-headers', () => {
  it('sets hardening headers', () => {
    const middleware = createSecurityMiddleware({ NODE_ENV: 'test' });
    const headers = {};
    const res = {
      setHeader(key, value) {
        headers[key] = value;
      },
      redirect: jest.fn(),
    };

    middleware({ get: () => undefined, secure: false, path: '/api/user', originalUrl: '/api/user' }, res, () => {});

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects to https in production when proto is http', () => {
    const middleware = createSecurityMiddleware({ NODE_ENV: 'production' });
    const res = {
      setHeader() {},
      redirect: jest.fn(),
    };
    const req = {
      get: (name) => {
        if (name === 'x-forwarded-proto') return 'http';
        if (name === 'host') return 'api.example.com';
        return undefined;
      },
      secure: false,
      path: '/api/user',
      originalUrl: '/api/user',
    };

    middleware(req, res, () => {});
    expect(res.redirect).toHaveBeenCalledWith(301, 'https://api.example.com/api/user');
  });
});

describe('location-retention job', () => {
  it('calls anonymizeExpiredLocations on runOnce', async () => {
    const anonymizeExpiredLocations = jest.fn().mockResolvedValue({ anonymizedCount: 2, ids: ['a', 'b'] });
    const job = startLocationRetentionJob(
      { anonymizeExpiredLocations },
      {
        env: {
          LOCATION_RETENTION_ENABLED: 'true',
          LOCATION_RETENTION_HOURS: '24',
          LOCATION_RETENTION_INTERVAL_MS: '60000',
        },
      }
    );

    const result = await job.runOnce();
    expect(anonymizeExpiredLocations).toHaveBeenCalledWith(24);
    expect(result.anonymizedCount).toBe(2);
    job.stop();
  });
});
