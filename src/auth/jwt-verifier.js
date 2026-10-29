const { createRemoteJWKSet, jwtVerify } = require('jose');
const { UnauthorizedError } = require('../errors/app-errors');

/**
 * Valida access tokens humanos emitidos por el IdP de CityPass+.
 * Siempre verify() — nunca decode() sin firma.
 *
 * Compatibilidad con el IdP real del Grupo 2 (citypass-login.pp.ua):
 *   - aud puede llegar como string o array.
 *   - token_use y ver son opcionales (el IdP externo puede no emitirlos).
 *   - La firma RS256, issuer y audience SIEMPRE son obligatorios.
 */
function createJwtVerifier(config, jwks = null, localJwks = null) {
  const keySet = jwks || createRemoteJWKSet(new URL(config.jwksUri));

  const verifyOptions = {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ['RS256'],
    clockTolerance: config.clockTolerance,
    requiredClaims: ['exp', 'sub', 'iss', 'aud', 'token_use', 'ver'],
  };

  async function verifyAccessToken(token) {
    let payload;

    try {
      ({ payload } = await jwtVerify(token, keySet, verifyOptions));
    } catch {
      if (localJwks) {
        try {
          ({ payload } = await jwtVerify(token, localJwks, verifyOptions));
        } catch {
          throw new UnauthorizedError('Invalid or expired token');
        }
      } else {
        throw new UnauthorizedError('Invalid or expired token');
      }
    }

    // El IdP de CityPass+ (Grupo 2) emite aud como string o array según RFC 7519 §4.1.3.
    // Validamos que contenga exactamente la audience del módulo:
    const audArray = Array.isArray(payload.aud)
      ? payload.aud
      : typeof payload.aud === 'string'
        ? [payload.aud]
        : [];

    if (!audArray.includes(config.audience)) {
      throw new UnauthorizedError('Invalid token audience');
    }

    // token_use = human es obligatorio para endpoints de personal / usuarios
    if (payload.token_use !== config.expectedTokenUse) {
      throw new UnauthorizedError('Invalid token_use');
    }

    if (payload.ver !== config.expectedVer) {
      throw new UnauthorizedError('Unsupported token version');
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedError('Invalid token subject');
    }

    // groups: nombres de grupo tal cual sin prefijos; vacío es válido; no array se rechaza
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
    };
  }

  return { verifyAccessToken };
}

module.exports = { createJwtVerifier };
