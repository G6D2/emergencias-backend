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
function createJwtVerifier(config, jwks = null) {
  const keySet = jwks || createRemoteJWKSet(new URL(config.jwksUri));

  async function verifyAccessToken(token) {
    let payload;

    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        clockTolerance: config.clockTolerance,
        // token_use y ver no son claims estándar OIDC: el IdP del Grupo 2
        // puede no incluirlos. Solo exigimos los claims RFC obligatorios.
        requiredClaims: ['exp', 'sub', 'iss', 'aud'],
      }));
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    // aud puede ser string (IdP externo) o array (contrato interno).
    // jose ya validó que config.audience está incluido; aceptamos ambas formas.
    const audArray = Array.isArray(payload.aud)
      ? payload.aud
      : typeof payload.aud === 'string'
        ? [payload.aud]
        : [];

    if (!audArray.includes(config.audience)) {
      throw new UnauthorizedError('Invalid token audience');
    }

    // token_use: si el IdP lo incluye, debe ser el valor esperado.
    // Si no lo incluye (IdP externo), se permite para interoperabilidad.
    if (payload.token_use !== undefined && payload.token_use !== config.expectedTokenUse) {
      throw new UnauthorizedError('Invalid token_use');
    }

    // ver: ídem — opcional para IdPs externos.
    if (payload.ver !== undefined && payload.ver !== config.expectedVer) {
      throw new UnauthorizedError('Unsupported token version');
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedError('Invalid token subject');
    }

    // groups: ausente → [] (ciudadano sin rol asignado todavía).
    // Tipo incorrecto (no array) → rechazar.
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
