const crypto = require('node:crypto');
const { createLocationCrypto } = require('../security/location-crypto');
const { startCitizenProfileRetentionJob } = require('../security/citizen-profile-retention');
const {
  CitizenProfileRepository,
  mapProfile,
  mapSavedLocation,
} = require('../repositories/citizen-profile.repository');
const { AuthUserRepository } = require('../repositories/auth-user.repository');
const { AuthController } = require('../controllers/auth.controller');
const { CitizenProfileController } = require('../controllers/citizen-profile.controller');

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

function encryptJsonLegacy(keyBase64, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv, {
    authTagLength: 16,
  });
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

describe('encryptJson / decryptJson coverage', () => {
  it('rejects non-object encryptJson input', () => {
    const api = createLocationCrypto(TEST_KEY);
    expect(() => api.encryptJson('nope')).toThrow(/plain object/);
    expect(() => api.encryptJson(null)).toThrow(/plain object/);
  });

  it('rejects invalid decryptJson input', () => {
    const api = createLocationCrypto(TEST_KEY);
    expect(() => api.decryptJson(null)).toThrow(/Invalid ciphertext/);
    expect(() => api.decryptJson('')).toThrow(/Invalid ciphertext/);
    expect(() => api.decryptJson(Buffer.from('short').toString('base64'))).toThrow(
      /Invalid ciphertext length/
    );
  });

  it('decrypts legacy json ciphertext via keyring fallback', () => {
    const legacy = encryptJsonLegacy(TEST_KEY, { phone: '11' });
    const api = createLocationCrypto({
      keys: { v1: TEST_KEY, v2: OTHER_KEY },
      activeKeyId: 'v2',
    });
    expect(api.decryptJson(legacy)).toEqual({ phone: '11' });
  });

  it('fails when versioned key id is missing from keyring', () => {
    const before = createLocationCrypto({ keys: { v1: TEST_KEY }, activeKeyId: 'v1' });
    const cipher = before.encryptJson({ medicalCondition: 'asma' });
    const after = createLocationCrypto({ keys: { v2: OTHER_KEY }, activeKeyId: 'v2' });
    expect(() => after.decryptJson(cipher)).toThrow(/key id "v1"/);
  });

  it('still decrypts after key rotation when old key remains', () => {
    const before = createLocationCrypto({ keys: { v1: TEST_KEY }, activeKeyId: 'v1' });
    const cipher = before.encryptJson({ phone: '99' });
    const after = createLocationCrypto({
      keys: { v1: TEST_KEY, v2: OTHER_KEY },
      activeKeyId: 'v2',
    });
    expect(after.decryptJson(cipher)).toEqual({ phone: '99' });
  });
});

describe('citizen profile retention coverage', () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('skips when repository is missing', () => {
    const job = startCitizenProfileRetentionJob(null, { env: {} });
    expect(job.runOnce).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('skipped'));
    job.stop();
  });

  it('rejects invalid retention days / interval', () => {
    const repo = { anonymizeStaleProfiles: jest.fn(), deleteStaleSavedLocations: jest.fn() };
    expect(() => startCitizenProfileRetentionJob(repo, {
      env: { CITIZEN_PII_RETENTION_DAYS: '0' },
    })).toThrow(/CITIZEN_PII_RETENTION_DAYS/);
    expect(() => startCitizenProfileRetentionJob(repo, {
      env: { CITIZEN_PII_RETENTION_INTERVAL_MS: '100' },
    })).toThrow(/CITIZEN_PII_RETENTION_INTERVAL_MS/);
  });

  it('runOnce returns null and logs on repository failure', async () => {
    const repo = {
      anonymizeStaleProfiles: jest.fn().mockRejectedValue(new Error('db down')),
      deleteStaleSavedLocations: jest.fn(),
    };
    const job = startCitizenProfileRetentionJob(repo, {
      env: { CITIZEN_PII_RETENTION_DAYS: '30', CITIZEN_PII_RETENTION_INTERVAL_MS: '60000' },
    });
    await expect(job.runOnce()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Citizen PII retention job failed'));
    job.stop();
  });

  it('does not log when nothing was cleaned', async () => {
    const repo = {
      anonymizeStaleProfiles: jest.fn().mockResolvedValue({ anonymizedCount: 0, userIds: [] }),
      deleteStaleSavedLocations: jest.fn().mockResolvedValue({ deletedCount: 0, ids: [] }),
    };
    const job = startCitizenProfileRetentionJob(repo, {
      env: { CITIZEN_PII_RETENTION_DAYS: '30', CITIZEN_PII_RETENTION_INTERVAL_MS: '60000' },
    });
    await job.runOnce();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('cleaned stale data'));
    job.stop();
  });
});

describe('CitizenProfileRepository retention methods', () => {
  const cryptoApi = createLocationCrypto(TEST_KEY);

  it('anonymizeStaleProfiles and deleteStaleSavedLocations require positive days', async () => {
    const repo = new CitizenProfileRepository({ query: async () => ({ rows: [], rowCount: 0 }) }, {
      locationCrypto: cryptoApi,
    });
    await expect(repo.anonymizeStaleProfiles(0)).rejects.toThrow(/retentionDays/);
    await expect(repo.deleteStaleSavedLocations('x')).rejects.toThrow(/retentionDays/);
  });

  it('anonymizeStaleProfiles clears ciphertext rows', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }],
      rowCount: 2,
    });
    const repo = new CitizenProfileRepository({ query }, { locationCrypto: cryptoApi });
    const result = await repo.anonymizeStaleProfiles(90);
    expect(result).toEqual({ anonymizedCount: 2, userIds: ['u1', 'u2'] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('sensitive_encrypted = NULL'), [90]);
  });

  it('deleteStaleSavedLocations deletes stale rows', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: 'l1' }],
      rowCount: 1,
    });
    const repo = new CitizenProfileRepository({ query }, { locationCrypto: cryptoApi });
    const result = await repo.deleteStaleSavedLocations(45);
    expect(result).toEqual({ deletedCount: 1, ids: ['l1'] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM citizen_saved_locations'), [45]);
  });

  it('mapProfile / mapSavedLocation tolerate undecryptable ciphertext', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const profile = mapProfile({
      user_id: 'u',
      display_name: 'X',
      sensitive_encrypted: 'not-valid-cipher',
      updated_at: 't',
    }, cryptoApi);
    expect(profile).toMatchObject({ name: 'X', phone: '', medicalCondition: '' });

    const loc = mapSavedLocation({
      id: '1',
      user_id: 'u',
      label: 'Casa',
      location_encrypted: 'not-valid',
      created_at: 't',
      updated_at: 't',
    }, cryptoApi);
    expect(loc).toMatchObject({ label: 'Casa', address: '', lat: null, lng: null });
    warn.mockRestore();
  });
});

describe('AuthUserRepository', () => {
  it('requires a pool', () => {
    expect(() => new AuthUserRepository(null)).toThrow(/pool/);
  });
});

describe('AuthController validation branches', () => {
  const issuer = {
    issueAccessToken: async () => ({ access_token: 't', token_type: 'Bearer', expires_in: 900 }),
  };

  it('rejects non-object bodies and bad email on register', async () => {
    const ctrl = new AuthController({ findByEmail: async () => null }, issuer);
    await expect(ctrl.register(null)).rejects.toThrow(/objeto JSON/);
    await expect(ctrl.register({ email: 'bad', password: 'secreto12' })).rejects.toThrow(/correo no es válido/);
  });

  it('rejects non-object login body and missing password', async () => {
    const ctrl = new AuthController({ findByEmail: async () => null }, issuer);
    await expect(ctrl.login([])).rejects.toThrow(/objeto JSON/);
    await expect(ctrl.login({ email: 'a@b.com' })).rejects.toThrow(/correo y la contraseña/);
  });

  it('uses displayName when preferred_username is absent', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'u1',
      displayName: 'FromDisplay',
      groups: ['citizen'],
      hasAntipanicButton: false,
      email: 'n@e.com',
    });
    const ctrl = new AuthController({
      findByEmail: async () => null,
      create,
    }, issuer);
    const result = await ctrl.register({
      email: 'n@e.com',
      password: 'secreto12',
      displayName: 'FromDisplay',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'FromDisplay' }));
    expect(result.user.username).toBe('FromDisplay');
  });
});

describe('CitizenProfileController validation branches', () => {
  const user = { sub: 'CIT-1' };

  it('rejects non-object profile body and NaN coords', async () => {
    const ctrl = new CitizenProfileController({
      upsertProfile: async () => ({}),
      addSavedLocation: async () => ({}),
    });
    await expect(ctrl.upsertProfile(user, null)).rejects.toThrow(/objeto JSON/);
    await expect(ctrl.addSavedLocation(user, null)).rejects.toThrow(/objeto JSON/);
    await expect(ctrl.addSavedLocation(user, {
      label: 'Casa',
      address: 'A',
      lat: 'nope',
    })).rejects.toThrow(/lat tiene que ser un número/);
  });

  it('rejects bad update body and missing location', async () => {
    const ctrl = new CitizenProfileController({
      updateSavedLocation: async () => null,
      removeSavedLocation: async () => false,
    });
    const id = '11111111-1111-4111-8111-111111111111';
    await expect(ctrl.updateSavedLocation(user, id, null)).rejects.toThrow(/objeto JSON/);
    await expect(ctrl.updateSavedLocation(user, id, { lng: 'x' })).rejects.toThrow(/lng tiene que ser un número/);
    await expect(ctrl.updateSavedLocation(user, id, { address: 'B' })).rejects.toThrow(/No se encontró la ubicación guardada/);
    await expect(ctrl.removeSavedLocation(user, id)).rejects.toThrow(/No se encontró la ubicación guardada/);
  });
});
