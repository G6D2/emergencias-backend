const {
  createBusLocationCrypto,
  getBusLocationCrypto,
  setBusLocationCryptoForTests,
} = require('../security/bus-location-crypto');

const TEST_KEY = Buffer.alloc(32, 9).toString('base64');

describe('bus-location-crypto', () => {
  afterEach(() => {
    setBusLocationCryptoForTests(undefined);
  });

  it('sin BUS_* env devolvé null', () => {
    expect(createBusLocationCrypto({ env: {} })).toBeNull();
  });

  it('round-trip de una coordenada', () => {
    const bus = createBusLocationCrypto({
      keys: { bus1: TEST_KEY },
      activeKeyId: 'bus1',
    });
    const ciphertext = bus.encryptCoordinate(-34.5735);
    expect(typeof ciphertext).toBe('string');
    expect(bus.decryptCoordinate(ciphertext)).toBeCloseTo(-34.5735);
  });

  it('getBusLocationCrypto cachea y respeta setBusLocationCryptoForTests', () => {
    setBusLocationCryptoForTests(null);
    expect(getBusLocationCrypto()).toBeNull();
    const bus = createBusLocationCrypto({ keys: { '1': TEST_KEY }, activeKeyId: '1' });
    setBusLocationCryptoForTests(bus);
    expect(getBusLocationCrypto()).toBe(bus);
  });
});
