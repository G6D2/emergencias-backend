// Clasifica los errores de procesamiento de un evento externo (ADR #25).
//
// Transitorio: el mismo evento puede andar si se reintenta (base caída,
// conexión cortada, registry inalcanzable). El listener lo relanza y kafkajs
// lo reentrega sin confirmar el offset.
//
// Permanente: reintentar no lo arregla (payload inválido, Avro corrupto,
// type sin handler, violación de constraint). El listener lo registra como
// descartado y deja avanzar el offset: un evento roto no puede frenar el
// tópico ni reentregarse para siempre.
//
// Se decide solo por código (SQLSTATE de Postgres, código de red de Node) o
// por la marca transient/permanent que pone quien sabe de dónde vino el error
// (event-decoder, OutcomeFactory). Nunca por el texto: el mensaje puede traer
// datos del evento, y un eventId con "timeout" adentro hacía pasar por
// transitorio un error permanente y trababa la partición para siempre.
//
// Lo que no se reconoce como transitorio se trata como permanente.

// 22 dato inválido (22P02: uuid mal formado), 23 violación de integridad: el
// mismo evento falla igual en cada reintento.
const PERMANENT_SQLSTATE_CLASSES = new Set(['22', '23']);

// 08 conexión, 53 recursos insuficientes, 57 operador (57P01 admin shutdown,
// 57P03 base arrancando, 57014 statement timeout). 40001/40P01: serialización
// y deadlock.
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

const SQLSTATE = /^[0-9A-Z]{5}$/;

function errorCodes(error) {
  return [error.code, error.cause && error.cause.code].filter((code) => typeof code === 'string');
}

function isPermanentCode(code) {
  return SQLSTATE.test(code) && PERMANENT_SQLSTATE_CLASSES.has(code.slice(0, 2));
}

function isTransientCode(code) {
  if (TRANSIENT_NODE_CODES.has(code)) return true;
  if (SQLSTATE.test(code)) {
    return TRANSIENT_SQLSTATE_CODES.has(code) || TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2));
  }
  return false;
}

function isTransientError(error) {
  if (!error) return false;
  if (error.transient === true) return true;
  if (error.permanent === true) return false;
  const codes = errorCodes(error);
  if (codes.some(isPermanentCode)) return false;
  return codes.some(isTransientCode);
}

module.exports = { isTransientError };
