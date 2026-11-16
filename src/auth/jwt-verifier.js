const { createRemoteJWKSet, jwtVerify } = require('jose');
const { UnauthorizedError } = require('../errors/app-errors');
const { logTokenRejection } = require('./token-rejection-log');

/**
 * Valida access tokens humanos emitidos por el IdP de CityPass+.
 * Siempre verify() — nunca decode() sin firma.
 */
function createJwtVerifier(config, jwks = null) {
  const keySet = jwks || createRemoteJWKSet(new URL(config.jwksUri));
  // Con AUTH_MODE=idp este verifier valida contra el JWKS remoto del IdP; en
  // local e hybrid, contra la clave propia. El log lo distingue.
  const verifierName = config.mode === 'idp' ? 'idp' : 'local';

  async function verifyAccessToken(token) {
    let payload;

    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        clockTolerance: config.clockTolerance,
        requiredClaims: ['exp', 'sub', 'iss', 'aud', 'token_use', 'ver'],
      }));
    } catch (error) {
      logTokenRejection(verifierName, error);
      throw new UnauthorizedError('Invalid or expired token');
    }

    // Contrato CityPass+: aud siempre es lista. Si llega string, rechazar.
    if (!Array.isArray(payload.aud)) {
      throw new UnauthorizedError('Invalid token audience claim');
    }

    if (!payload.aud.includes(config.audience)) {
      throw new UnauthorizedError('Invalid token audience');
    }

    if (payload.token_use !== config.expectedTokenUse) {
      throw new UnauthorizedError('Invalid token_use');
    }

    if (payload.ver !== config.expectedVer) {
      throw new UnauthorizedError('Unsupported token version');
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedError('Invalid token subject');
    }

    // groups vacío es válido; ausente o tipo incorrecto → lista vacía / rechazo
    if (payload.groups !== undefined && !Array.isArray(payload.groups)) {
      throw new UnauthorizedError('Invalid groups claim');
    }

    const groups = Array.isArray(payload.groups)
      ? payload.groups.filter((g) => typeof g === 'string')
      : [];

    return {
      sub: payload.sub,
      username: typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : undefined,
      groups,
      module: typeof payload.module === 'string' ? payload.module : undefined,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
      tokenUse: payload.token_use,
      hasAntipanicButton: typeof payload.has_antipanic_button === 'boolean'
        ? payload.has_antipanic_button
        : undefined,
    };
  }

  return { verifyAccessToken };
}

module.exports = { createJwtVerifier };
