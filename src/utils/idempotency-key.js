const { ValidationError } = require('../errors/app-errors');

// Header Idempotency-Key de las altas (hoy solo POST /api/panic-button). El
// BFF del front manda un UUID v4 por pedido lógico y lo repite en cada
// reintento (lib/backend-fetch.js del Frontend).
//
// Formato aceptado: de 1 a 128 caracteres entre letras, números y "_ . : -".
// Alcanza para UUID, ULID y claves con prefijo, y no deja pasar espacios,
// comas (dos headers repetidos llegan unidos por ", ") ni caracteres de
// control. También se acepta entre comillas dobles, como lo escribe el draft
// de la IETF (sf-string): las comillas no forman parte de la clave.
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Devuelve la clave lista para usar, o null si el pedido no trae una (header
 * ausente o vacío: el alta sigue como siempre). Una clave mal formada corta
 * con 400.
 *
 * @param {string|undefined} rawHeader - req.get('Idempotency-Key')
 * @returns {string|null}
 */
function parseIdempotencyKey(rawHeader) {
  if (rawHeader === undefined || rawHeader === null) return null;
  let key = String(rawHeader).trim();
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1);
  }
  if (key === '') return null;
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ValidationError(
      `Idempotency-Key inválida: hasta ${MAX_IDEMPOTENCY_KEY_LENGTH} caracteres entre letras, números y "_ . : -"`
    );
  }
  return key;
}

module.exports = {
  parseIdempotencyKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
};
