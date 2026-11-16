const { secureLog } = require('../security/secure-log');

/**
 * Deja en el log por qué se rechazó un token.
 *
 * La respuesta es siempre el mismo 401 "Invalid or expired token" (al cliente
 * no se le cuenta la causa), así que sin esto el log no distingue un token
 * vencido, que es rutina, del JWKS del Login Federado caído, que deja afuera
 * a todo el personal.
 *
 * Se loguea SOLO el código y el nombre del error. Nunca su mensaje, el token,
 * sus claims ni el header Authorization. Qué esperar:
 * - Problema del token (jose): ERR_JWT_EXPIRED / JWTExpired,
 *   ERR_JWT_CLAIM_VALIDATION_FAILED, ERR_JWS_SIGNATURE_VERIFICATION_FAILED,
 *   ERR_JWS_INVALID, ERR_JWT_INVALID.
 * - Problema del JWKS (jose): ERR_JWKS_TIMEOUT / JWKSTimeout,
 *   ERR_JWKS_NO_MATCHING_KEY, ERR_JWKS_INVALID, y ERR_JOSE_GENERIC / JOSEError
 *   cuando el JWKS respondió algo que no es un 200 con JSON.
 * - Problema de red (Node, no se llegó al JWKS): ECONNREFUSED, ENOTFOUND...
 *
 * @param {'local'|'idp'|'federated'|'hybrid'|'authenticate'} verifier - quién rechazó
 * @param {unknown} error - el error original (de jose o de Node)
 */
function logTokenRejection(verifier, error) {
  secureLog('warn', 'Token rechazado', {
    verifier,
    code: error?.code,
    name: error?.name,
  });
}

module.exports = { logTokenRejection };
