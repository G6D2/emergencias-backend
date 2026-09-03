const crypto = require('crypto');
const { createLocationCrypto } = require('../security/location-crypto');
const { redactObject, summarizeEventForLog } = require('../security/secure-log');
const { createSecurityMiddleware } = require('../security/security-headers');
const { startLocationRetentionJob } = require('../security/location-retention');

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const ROTATED_KEY = Buffer.alloc(32, 9).toString('base64');

// Escribe un ciphertext con el formato viejo (sin cabecera de versión) para
// verificar que las filas anteriores a la rotación se siguen leyendo.
function encryptLegacy(keyBase64, { latitude, longitude }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv, {
    authTagLength: 16,
  });
  const plaintext = Buffer.from(JSON.stringify({ latitude, longitude }), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

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

  it('stamps the active key id on new ciphertexts', () => {
    const rotatable = createLocationCrypto({
      keys: { v1: TEST_KEY, v2: ROTATED_KEY },
      activeKeyId: 'v2',
    });

    expect(rotatable.activeKeyId).toBe('v2');
    expect(rotatable.keyIds).toEqual(['v1', 'v2']);

    const ciphertext = rotatable.encryptLocation({ latitude: -34.6, longitude: -58.4 });
    const header = Buffer.from(ciphertext, 'base64');
    expect(header.subarray(0, 3).toString('ascii')).toBe('ELC');
    expect(header.readUInt8(3)).toBe(1);
    expect(header.subarray(5, 7).toString('ascii')).toBe('v2');
  });

  it('decrypts rows written with a retired key still in the keyring', () => {
    const before = createLocationCrypto({ keys: { v1: TEST_KEY }, activeKeyId: 'v1' });
    const ciphertext = before.encryptLocation({ latitude: -34.6037, longitude: -58.3816 });

    const after = createLocationCrypto({
      keys: { v1: TEST_KEY, v2: ROTATED_KEY },
      activeKeyId: 'v2',
    });

    const plain = after.decryptLocation(ciphertext);
    expect(plain.latitude).toBeCloseTo(-34.6037);
    expect(plain.longitude).toBeCloseTo(-58.3816);
  });

  it('fails loudly when the key id of a row is not in the keyring', () => {
    const before = createLocationCrypto({ keys: { v1: TEST_KEY }, activeKeyId: 'v1' });
    const ciphertext = before.encryptLocation({ latitude: -34.6, longitude: -58.4 });

    const after = createLocationCrypto({ keys: { v2: ROTATED_KEY }, activeKeyId: 'v2' });
    expect(() => after.decryptLocation(ciphertext)).toThrow(/key id "v1"/);
  });

  it('still decrypts pre-versioning ciphertexts', () => {
    const legacy = encryptLegacy(TEST_KEY, { latitude: -34.6037, longitude: -58.3816 });

    const rotatable = createLocationCrypto({
      keys: { v1: TEST_KEY, v2: ROTATED_KEY },
      activeKeyId: 'v2',
    });

    const plain = rotatable.decryptLocation(legacy);
    expect(plain.latitude).toBeCloseTo(-34.6037);
    expect(plain.longitude).toBeCloseTo(-58.3816);
  });

  it('parses a keyring from a single env string', () => {
    const fromEnv = createLocationCrypto({ keys: `v1:${TEST_KEY},v2:${ROTATED_KEY}` });
    expect(fromEnv.activeKeyId).toBe('v1');
    expect(fromEnv.keyIds).toEqual(['v1', 'v2']);
  });

  it('rejects an active key id missing from the keyring', () => {
    expect(() => createLocationCrypto({ keys: { v1: TEST_KEY }, activeKeyId: 'v9' }))
      .toThrow(/not in the keyring/);
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
      status: 'PENDING',
      latitude: -34.6,
      longitude: -58.4,
    });

    expect(summary).toEqual({
      topic: 'emergencias.boton-panico',
      type: undefined,
      emergencyId: 'e1',
      status: 'PENDING',
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
