const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Cabecera de los ciphertexts versionados:
//   MAGIC(3) || FORMAT_VERSION(1) || keyIdLength(1) || keyId || iv(12) || authTag(16) || ct
// Las filas pre-versionado (iv || authTag || ct, sin cabecera) se siguen
// desencriptando: ver decryptLocation.
const MAGIC = Buffer.from('ELC', 'ascii');
const FORMAT_VERSION = 1;
const HEADER_LENGTH = MAGIC.length + 2;
const MAX_KEY_ID_LENGTH = 64;
const DEFAULT_KEY_ID = '1';

function parseEncryptionKey(keyMaterial) {
  if (!keyMaterial || typeof keyMaterial !== 'string') {
    throw new Error(
      'LOCATION_ENCRYPTION_KEY is required (32-byte key as base64, e.g. openssl rand -base64 32)'
    );
  }

  const key = Buffer.from(keyMaterial, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `LOCATION_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length})`
    );
  }

  return key;
}

function assertValidKeyId(keyId) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(keyId)) {
    throw new Error(
      `Invalid location encryption key id "${keyId}" (allowed: letters, digits, _ . -)`
    );
  }
  return keyId;
}

/**
 * Acepta "id:base64key,id2:base64key2" (keyring) o una sola key en base64.
 * Devuelve un Map keyId -> Buffer, en el orden declarado.
 */
function parseKeyring(keyringMaterial) {
  if (!keyringMaterial || typeof keyringMaterial !== 'string') {
    throw new Error(
      'LOCATION_ENCRYPTION_KEYS is required ("id:base64key,id2:base64key2")'
    );
  }

  const keys = new Map();
  const entries = keyringMaterial.split(',').map((entry) => entry.trim()).filter(Boolean);

  if (entries.length === 0) {
    throw new Error('LOCATION_ENCRYPTION_KEYS is empty');
  }

  entries.forEach((entry) => {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error('LOCATION_ENCRYPTION_KEYS entries must be "keyId:base64key"');
    }

    const keyId = assertValidKeyId(entry.slice(0, separatorIndex).trim());
    if (keys.has(keyId)) {
      throw new Error(`Duplicated location encryption key id "${keyId}"`);
    }

    keys.set(keyId, parseEncryptionKey(entry.slice(separatorIndex + 1).trim()));
  });

  return keys;
}

/**
 * Normaliza las tres formas de configurar el cifrado:
 *   - string base64  -> keyring de una key (id LOCATION_ENCRYPTION_KEY_ID o "1")
 *   - { keys, activeKeyId } -> keys como Map/objeto/string de keyring
 *   - undefined -> lee env (LOCATION_ENCRYPTION_KEYS o LOCATION_ENCRYPTION_KEY)
 */
function resolveKeyring(config) {
  if (typeof config === 'string' || config === undefined || config === null) {
    const keyringMaterial = config === undefined || config === null
      ? process.env.LOCATION_ENCRYPTION_KEYS
      : null;

    if (keyringMaterial) {
      const keys = parseKeyring(keyringMaterial);
      const activeKeyId = process.env.LOCATION_ENCRYPTION_KEY_ID
        ? assertValidKeyId(process.env.LOCATION_ENCRYPTION_KEY_ID.trim())
        : keys.keys().next().value;

      if (!keys.has(activeKeyId)) {
        throw new Error(
          `LOCATION_ENCRYPTION_KEY_ID "${activeKeyId}" is not present in LOCATION_ENCRYPTION_KEYS`
        );
      }

      return { keys, activeKeyId };
    }

    const keyMaterial = config === undefined || config === null
      ? process.env.LOCATION_ENCRYPTION_KEY
      : config;
    const activeKeyId = assertValidKeyId(
      (process.env.LOCATION_ENCRYPTION_KEY_ID || DEFAULT_KEY_ID).trim()
    );

    return {
      keys: new Map([[activeKeyId, parseEncryptionKey(keyMaterial)]]),
      activeKeyId,
    };
  }

  if (typeof config !== 'object') {
    throw new Error('Invalid location crypto configuration');
  }

  let keys;
  if (config.keys instanceof Map) {
    keys = new Map();
    config.keys.forEach((value, keyId) => {
      keys.set(
        assertValidKeyId(String(keyId)),
        Buffer.isBuffer(value) ? value : parseEncryptionKey(value)
      );
    });
  } else if (typeof config.keys === 'string') {
    keys = parseKeyring(config.keys);
  } else if (config.keys && typeof config.keys === 'object') {
    keys = new Map(
      Object.entries(config.keys).map(([keyId, value]) => [
        assertValidKeyId(keyId),
        Buffer.isBuffer(value) ? value : parseEncryptionKey(value),
      ])
    );
  } else {
    throw new Error('Invalid location crypto configuration: missing keys');
  }

  keys.forEach((key, keyId) => {
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `Location encryption key "${keyId}" must be ${KEY_LENGTH} bytes (got ${key.length})`
      );
    }
  });

  if (keys.size === 0) {
    throw new Error('Invalid location crypto configuration: empty keyring');
  }

  const activeKeyId = config.activeKeyId
    ? assertValidKeyId(String(config.activeKeyId))
    : keys.keys().next().value;

  if (!keys.has(activeKeyId)) {
    throw new Error(`Active location encryption key id "${activeKeyId}" is not in the keyring`);
  }

  return { keys, activeKeyId };
}

function encodePayload({ keyId, iv, authTag, encrypted }) {
  const keyIdBuffer = Buffer.from(keyId, 'ascii');
  if (keyIdBuffer.length > MAX_KEY_ID_LENGTH) {
    throw new Error(`Location encryption key id "${keyId}" is too long`);
  }

  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, MAGIC.length);
  header.writeUInt8(keyIdBuffer.length, MAGIC.length + 1);

  return Buffer.concat([header, keyIdBuffer, iv, authTag, encrypted]);
}

/**
 * Devuelve { keyId, iv, authTag, encrypted } si el payload trae la cabecera
 * versionada, o null si parece del formato viejo (o si la cabecera no cierra).
 */
function decodeVersionedPayload(payload) {
  if (payload.length < HEADER_LENGTH || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    return null;
  }

  if (payload.readUInt8(MAGIC.length) !== FORMAT_VERSION) {
    return null;
  }

  const keyIdLength = payload.readUInt8(MAGIC.length + 1);
  const keyIdEnd = HEADER_LENGTH + keyIdLength;
  const bodyStart = keyIdEnd + IV_LENGTH + AUTH_TAG_LENGTH;

  if (keyIdLength === 0 || keyIdLength > MAX_KEY_ID_LENGTH || payload.length <= bodyStart) {
    return null;
  }

  return {
    keyId: payload.subarray(HEADER_LENGTH, keyIdEnd).toString('ascii'),
    iv: payload.subarray(keyIdEnd, keyIdEnd + IV_LENGTH),
    authTag: payload.subarray(keyIdEnd + IV_LENGTH, bodyStart),
    encrypted: payload.subarray(bodyStart),
  };
}

function decodeLegacyPayload(payload) {
  if (payload.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    return null;
  }

  return {
    keyId: null,
    iv: payload.subarray(0, IV_LENGTH),
    authTag: payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH),
    encrypted: payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH),
  };
}

/**
 * AES-256-GCM para la ubicación at rest, con keyring para poder rotar.
 * Formato: base64("ELC" || version || keyIdLen || keyId || iv || authTag || ct)
 * Las filas escritas antes del versionado (base64(iv || authTag || ct)) se
 * siguen leyendo probando las keys del keyring.
 *
 * El plaintext cifrado es JSON: { latitude, longitude } y, si se proveyó,
 * `address` (dirección legible). No hay columna ni migración nueva para
 * address: viaja dentro del mismo ciphertext para heredar retención de 72h,
 * anonimización y saneo de filas indescifrables sin tocar el schema.
 */
function createLocationCrypto(config) {
  const { keys, activeKeyId } = resolveKeyring(config);
  const activeKey = keys.get(activeKeyId);

  function decryptWith(key, { iv, authTag, encrypted }) {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));

    return {
      latitude: Number(parsed.latitude),
      longitude: Number(parsed.longitude),
      // Campo opcional agregado al mismo plaintext cifrado (sin migración):
      // ausente en filas escritas antes de esto, o si no vino en el request.
      address: typeof parsed.address === 'string' ? parsed.address : null,
    };
  }

  function encryptLocation({ latitude, longitude, address }) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number'
      || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      throw new Error('latitude and longitude must be numbers');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, activeKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    // address es opcional: solo se agrega al JSON cifrado si vino un string
    // no vacío, para no ensuciar el plaintext de las emergencias sin dirección.
    const payload = typeof address === 'string' && address.length > 0
      ? { latitude, longitude, address }
      : { latitude, longitude };
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return encodePayload({
      keyId: activeKeyId,
      iv,
      authTag: cipher.getAuthTag(),
      encrypted,
    }).toString('base64');
  }

  function decryptLocation(ciphertextBase64) {
    if (!ciphertextBase64 || typeof ciphertextBase64 !== 'string') {
      throw new Error('Invalid location ciphertext');
    }

    const payload = Buffer.from(ciphertextBase64, 'base64');
    const versioned = decodeVersionedPayload(payload);

    if (versioned) {
      const key = keys.get(versioned.keyId);
      if (key) {
        try {
          return decryptWith(key, versioned);
        } catch (err) {
          // Un ciphertext viejo puede empezar con los bytes de MAGIC por azar
          // (~1 en 2^32): si falla, se reintenta abajo como formato legacy.
          void err;
        }
      }
    }

    const legacy = decodeLegacyPayload(payload);
    if (!legacy) {
      throw new Error('Invalid location ciphertext length');
    }

    // Sin keyId en el formato viejo: se prueban todas las keys del keyring.
    let lastError = null;
    for (const key of keys.values()) {
      try {
        return decryptWith(key, legacy);
      } catch (err) {
        lastError = err;
      }
    }

    if (versioned && !keys.has(versioned.keyId)) {
      throw new Error(
        `No location encryption key available for key id "${versioned.keyId}"`
      );
    }

    throw lastError || new Error('Invalid location ciphertext');
  }

  return {
    encryptLocation,
    decryptLocation,
    activeKeyId,
    keyIds: Array.from(keys.keys()),
  };
}

module.exports = { createLocationCrypto, parseEncryptionKey, parseKeyring };
