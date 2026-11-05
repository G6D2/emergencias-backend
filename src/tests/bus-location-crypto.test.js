const {
  createBusLocationCrypto,
  getBusLocationCrypto,
  setBusLocationCryptoForTests,
  assertBusLocationCryptoAtBoot,
} = require('../security/bus-location-crypto');

const TEST_KEY = Buffer.alloc(32, 9).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 3).toString('base64');

describe('bus-location-crypto', () => {
  afterEach(() => {
    setBusLocationCryptoForTests(undefined);
  });

  it('sin BUS_* env devolvé null', () => {
    expect(createBusLocationCrypto({ env: {} })).toBeNull();
  });

  it('round-trip de una coordenada con AAD', () => {
    const bus = createBusLocationCrypto({
      keys: { bus1: TEST_KEY },
      activeKeyId: 'bus1',
    });
    const ctx = { emergencyId: 'e-1', field: 'latitud' };
    const ciphertext = bus.encryptCoordinate(-34.5735, ctx);
    expect(typeof ciphertext).toBe('string');
    expect(bus.decryptCoordinate(ciphertext, ctx)).toBeCloseTo(-34.5735);
  });

  it('rechaza decrypt con AAD de otro campo o emergencia', () => {
    const bus = createBusLocationCrypto({
      keys: { bus1: TEST_KEY },
      activeKeyId: 'bus1',
    });
    const ct = bus.encryptCoordinate(-58.4, { emergencyId: 'e-1', field: 'longitud' });
    expect(() => bus.decryptCoordinate(ct, { emergencyId: 'e-1', field: 'latitud' })).toThrow();
    expect(() => bus.decryptCoordinate(ct, { emergencyId: 'e-2', field: 'longitud' })).toThrow();
  });

  it('trimea BUS_LOCATION_ENCRYPTION_KEY_ID con keyring', () => {
    const bus = createBusLocationCrypto({
      env: {
        BUS_LOCATION_ENCRYPTION_KEYS: `v1:${TEST_KEY},v2:${OTHER_KEY}`,
        BUS_LOCATION_ENCRYPTION_KEY_ID: ' v2 ',
      },
    });
    expect(bus.activeKeyId).toBe('v2');
  });

  it('assertBusLocationCryptoAtBoot rechaza clave igual a la de DB', () => {
    expect(() => assertBusLocationCryptoAtBoot({
      env: {
        LOCATION_ENCRYPTION_KEY: TEST_KEY,
        BUS_LOCATION_ENCRYPTION_KEY: TEST_KEY,
      },
    })).toThrow(/different from LOCATION_ENCRYPTION_KEY/);
  });

  it('assertBusLocationCryptoAtBoot acepta clave distinta y cachea', () => {
    const bus = assertBusLocationCryptoAtBoot({
      env: {
        LOCATION_ENCRYPTION_KEY: TEST_KEY,
        BUS_LOCATION_ENCRYPTION_KEY: OTHER_KEY,
      },
    });
    expect(bus).not.toBeNull();
    expect(getBusLocationCrypto()).toBe(bus);
  });

  it('getBusLocationCrypto cachea y respeta setBusLocationCryptoForTests', () => {
    setBusLocationCryptoForTests(null);
    expect(getBusLocationCrypto()).toBeNull();
    const bus = createBusLocationCrypto({ keys: { '1': TEST_KEY }, activeKeyId: '1' });
    setBusLocationCryptoForTests(bus);
    expect(getBusLocationCrypto()).toBe(bus);
  });
});
