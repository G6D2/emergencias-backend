// Clasifica los errores de procesamiento de un evento externo (ADR #25).
//
// Transitorio: el mismo evento puede andar si se reintenta (base caída,
// timeout, registry inalcanzable). El listener lo relanza y kafkajs lo
// reentrega sin confirmar el offset.
//
// Permanente: reintentar no lo arregla (payload inválido, Avro corrupto,
// type sin handler, violación de constraint). El listener lo registra como
// descartado y deja avanzar el offset: un evento roto no puede frenar el
// tópico ni reentregarse para siempre.
//
// Lo que no se reconoce como transitorio se trata como permanente.

// Clases de SQLSTATE: 08 conexión, 53 recursos insuficientes, 57 operador
// (admin shutdown, statement timeout). 40001/40P01: serialización y deadlock.
const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '53', '57']);
const TRANSIENT_SQLSTATE_CODES = new Set(['40001', '40P01']);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const TRANSIENT_MESSAGE = /timeout|connection terminated|socket hang up|fetch failed/i;

function isTransientCode(code) {
  if (typeof code !== 'string') return false;
  if (TRANSIENT_NODE_CODES.has(code)) return true;
  if (/^[0-9A-Z]{5}$/.test(code)) {
    return TRANSIENT_SQLSTATE_CODES.has(code) || TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2));
  }
  return false;
}

function isTransientError(error) {
  if (!error) return false;
  if (error.transient === true) return true;
  if (error.permanent === true) return false;
  if (isTransientCode(error.code) || isTransientCode(error.cause && error.cause.code)) return true;
  return TRANSIENT_MESSAGE.test(String(error.message || ''));
}

module.exports = { isTransientError };
