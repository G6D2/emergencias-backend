const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

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

/**
 * AES-256-GCM for location at rest.
 * Format: base64(iv || authTag || ciphertext)
 */
function createLocationCrypto(keyMaterial = process.env.LOCATION_ENCRYPTION_KEY) {
  const key = parseEncryptionKey(keyMaterial);

  function encryptLocation({ latitude, longitude }) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number'
      || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      throw new Error('latitude and longitude must be numbers');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const plaintext = Buffer.from(JSON.stringify({ latitude, longitude }), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  function decryptLocation(ciphertextBase64) {
    if (!ciphertextBase64 || typeof ciphertextBase64 !== 'string') {
      throw new Error('Invalid location ciphertext');
    }

    const payload = Buffer.from(ciphertextBase64, 'base64');
    if (payload.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Invalid location ciphertext length');
    }

    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));

    return {
      latitude: Number(parsed.latitude),
      longitude: Number(parsed.longitude),
    };
  }

  return { encryptLocation, decryptLocation };
}

module.exports = { createLocationCrypto, parseEncryptionKey };
