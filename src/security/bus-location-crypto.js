const { createLocationCrypto } = require('./location-crypto');
const { secureLog } = require('./secure-log');

// Cifrado de lat/lng para el bus (clave distinta a la de DB).
// Wire format = el mismo AES-256-GCM versionado (ELC…).
// Plaintext por coordenada: JSON `{"value": <number>}`.

let cached = undefined;

function resolveBusCryptoConfig(env) {
  if (env.BUS_LOCATION_ENCRYPTION_KEYS) {
    return {
      keys: env.BUS_LOCATION_ENCRYPTION_KEYS,
      activeKeyId: env.BUS_LOCATION_ENCRYPTION_KEY_ID || undefined,
    };
  }
  if (env.BUS_LOCATION_ENCRYPTION_KEY) {
    const keyId = (env.BUS_LOCATION_ENCRYPTION_KEY_ID || '1').trim();
    return {
      keys: { [keyId]: env.BUS_LOCATION_ENCRYPTION_KEY },
      activeKeyId: keyId,
    };
  }
  return null;
}

function wrapLocationCrypto(locationCrypto) {
  return {
    activeKeyId: locationCrypto.activeKeyId,
    encryptCoordinate(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new Error('bus coordinate must be a finite number');
      }
      return locationCrypto.encryptJson({ value: n });
    },
    decryptCoordinate(ciphertextBase64) {
      const parsed = locationCrypto.decryptJson(ciphertextBase64);
      const n = Number(parsed && parsed.value);
      if (!Number.isFinite(n)) {
        throw new Error('Invalid bus coordinate plaintext');
      }
      return n;
    },
  };
}

/**
 * Crypto opcional para el bus. Sin BUS_LOCATION_ENCRYPTION_KEY(S) → null
 * (el evento publica ubicacion.latitud/longitud en null).
 */
function createBusLocationCrypto(configOrEnv) {
  if (configOrEnv && (configOrEnv.keys || typeof configOrEnv === 'string')) {
    return wrapLocationCrypto(createLocationCrypto(configOrEnv));
  }

  const env = configOrEnv && typeof configOrEnv === 'object' && configOrEnv.env
    ? configOrEnv.env
    : (configOrEnv || process.env);
  const resolved = resolveBusCryptoConfig(env);
  if (!resolved) return null;

  return wrapLocationCrypto(createLocationCrypto(resolved));
}

function getBusLocationCrypto() {
  if (cached !== undefined) return cached;
  try {
    cached = createBusLocationCrypto();
    if (!cached) {
      secureLog('warn', 'BUS_LOCATION_ENCRYPTION_KEY not set; ubicacion.latitud/longitud will be null on the bus');
    }
  } catch (error) {
    secureLog('error', 'Invalid BUS_LOCATION_ENCRYPTION_* config; bus coords disabled', {
      message: error.message,
    });
    cached = null;
  }
  return cached;
}

/** Solo tests: inyectar o resetear el singleton. */
function setBusLocationCryptoForTests(crypto) {
  cached = crypto;
}

module.exports = {
  createBusLocationCrypto,
  getBusLocationCrypto,
  setBusLocationCryptoForTests,
};
