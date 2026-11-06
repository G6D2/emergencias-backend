const { decodeJwt } = require('jose');
const { UnauthorizedError } = require('../errors/app-errors');

/**
 * AUTH_MODE=hybrid: elige con qué verifier validar según el `iss` del token.
 *
 * decodeJwt() se usa SOLO para leer `iss` y elegir el juego de claves. La
 * autenticación la hace después el verifier elegido con verify() completo
 * (firma, `iss` exacto, `aud`, `exp`...), así que un `iss` falso no sirve de
 * nada: un token que dice ser federado se valida contra el JWKS del Grupo 2 y
 * uno que dice ser local, contra la clave local.
 *
 * @param {{ issuer: string, verifyAccessToken: (token: string) => Promise<object> }} local
 * @param {{ issuer: string, verifyAccessToken: (token: string) => Promise<object> }} federated
 */
function createHybridVerifier({ local, federated }) {
  if (local.issuer === federated.issuer) {
    throw new Error('Hybrid auth needs different issuers for local and federated tokens');
  }

  async function verifyAccessToken(token) {
    let issuer;
    try {
      ({ iss: issuer } = decodeJwt(token));
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    if (issuer === federated.issuer) {
      return federated.verifyAccessToken(token);
    }

    if (issuer === local.issuer) {
      const user = await local.verifyAccessToken(token);
      return { ...user, authSource: 'local' };
    }

    throw new UnauthorizedError('Unknown token issuer');
  }

  return { verifyAccessToken };
}

module.exports = { createHybridVerifier };
