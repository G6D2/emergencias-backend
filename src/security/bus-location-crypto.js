const { createLocationCrypto } = require('./location-crypto');
const { secureLog } = require('./secure-log');

// Cifrado de lat/lng para el bus (clave distinta a la de DB).
// Wire format = el mismo AES-256-GCM versionado (ELC…).
// Plaintext por coordenada: JSON `{"value": <number>}`.
// AAD: `${emergenciaId}|latitud` / `${emergenciaId}|longitud` (anti swap/reuse).

let cached = undefined;

function resolveBusCryptoConfig(env) {
  if (env.BUS_LOCATION_ENCRYPTION_KEYS) {
    const activeKeyId = env.BUS_LOCATION_ENCRYPTION_KEY_ID
      ? String(env.BUS_LOCATION_ENCRYPTION_KEY_ID).trim()
      : undefined;
    return {
      keys: env.BUS_LOCATION_ENCRYPTION_KEYS,
      activeKeyId: activeKeyId || undefined,
    };
  }
  if (env.BUS_LOCATION_ENCRYPTION_KEY) {
    const keyId = String(env.BUS_LOCATION_ENCRYPTION_KEY_ID || '1').trim();
    return {
      keys: { [keyId]: env.BUS_LOCATION_ENCRYPTION_KEY },
      activeKeyId: keyId,
    };
  }
  return null;
}

function busAad(emergencyId, field) {
  if (!emergencyId || !field) {
    throw new Error('bus coordinate AAD requires emergencyId and field');
  }
  return `${emergencyId}|${field}`;
}

function wrapLocationCrypto(locationCrypto) {
  return {
    activeKeyId: locationCrypto.activeKeyId,
    encryptCoordinate(value, { emergencyId, field } = {}) {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new Error('bus coordinate must be a finite number');
      }
      return locationCrypto.encryptJson(
        { value: n },
        { aad: busAad(emergencyId, field) }
      );
    },
    decryptCoordinate(ciphertextBase64, { emergencyId, field } = {}) {
      const parsed = locationCrypto.decryptJson(ciphertextBase64, {
        aad: busAad(emergencyId, field),
      });
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

/**
 * Valida la config de bus al arrancar.
 * - Si hay clave de bus inválida → throw (fail fast).
 * - Si coincide con LOCATION_ENCRYPTION_KEY → throw.
 * - Si no hay clave de bus → warn (coords del bus salen null).
 */
function assertBusLocationCryptoAtBoot(options = {}) {
  const env = options.env || process.env;
  const dbKey = env.LOCATION_ENCRYPTION_KEY || null;
  const busKey = env.BUS_LOCATION_ENCRYPTION_KEY || null;
  const hasKeyring = Boolean(env.BUS_LOCATION_ENCRYPTION_KEYS);

  if (!busKey && !hasKeyring) {
    secureLog('warn', 'BUS_LOCATION_ENCRYPTION_KEY not set; ubicacion.latitud/longitud will be null on the bus');
    setBusLocationCryptoForTests(null);
    return null;
  }

  if (busKey && dbKey && busKey === dbKey) {
    throw new Error(
      'BUS_LOCATION_ENCRYPTION_KEY must be different from LOCATION_ENCRYPTION_KEY'
    );
  }

  let bus;
  try {
    bus = createBusLocationCrypto({ env });
  } catch (error) {
    throw new Error(`Invalid BUS_LOCATION_ENCRYPTION_* config: ${error.message}`);
  }

  // Round-trip mínimo para validar la key material.
  const probe = bus.encryptCoordinate(-34.6, { emergencyId: 'boot-probe', field: 'latitud' });
  const roundTrip = bus.decryptCoordinate(probe, { emergencyId: 'boot-probe', field: 'latitud' });
  if (!Number.isFinite(roundTrip)) {
    throw new Error('BUS_LOCATION_ENCRYPTION_KEY failed encrypt/decrypt probe');
  }

  setBusLocationCryptoForTests(bus);
  return bus;
}

/** Solo tests: inyectar o resetear el singleton. */
function setBusLocationCryptoForTests(crypto) {
  cached = crypto;
}

module.exports = {
  createBusLocationCrypto,
  getBusLocationCrypto,
  setBusLocationCryptoForTests,
  assertBusLocationCryptoAtBoot,
  busAad,
};
