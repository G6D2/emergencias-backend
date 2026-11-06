const { jwtVerify } = require('jose');
const { UnauthorizedError } = require('../errors/app-errors');
const { mapFederatedGroups } = require('./federated-claims');

// Grupos del token: lista de strings (lo que dice el contrato) o un string
// suelto. Cualquier otra cosa es un token mal formado.
function readGroups(value) {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((g) => typeof g === 'string');
  throw new UnauthorizedError('Invalid groups claim');
}

/**
 * Valida access tokens humanos del Login Federado del Grupo 2
 * (POST https://api.citypass-login.pp.ua/auth/login). Siempre verify(): firma
 * RS256 contra el JWKS remoto, `iss` exacto, nuestra audience dentro de `aud`
 * y `exp` presente y vigente.
 *
 * Diferencias con los tokens locales (jwt-verifier.js), porque todavía no
 * vimos un token real y el PR #65 reportó `aud` como string:
 * - `aud` puede ser string o lista (jose acepta las dos formas).
 * - `token_use` y `ver` se validan si vienen ('human' y 1, como en el contrato
 *   del Grupo 2) y solo son obligatorios con IDP_REQUIRE_TOKEN_USE /
 *   IDP_REQUIRE_TOKEN_VER. Un token de servicio (`token_use: service`) del
 *   mismo IdP se rechaza igual.
 * - El claim del usuario (IDP_SUBJECT_CLAIM) y el de grupos (IDP_GROUPS_CLAIM)
 *   son configurables; los grupos pasan por IDP_GROUP_MAP.
 *
 * @param {object} config - config.federated de loadAuthConfig()
 * @param {import('jose').JWTVerifyGetKey} keySet - JWKS remoto (o local en tests)
 */
function createFederatedVerifier(config, keySet) {
  const requiredClaims = ['exp', 'iss', 'aud'];
  if (config.requireTokenUse) requiredClaims.push('token_use');
  if (config.requireTokenVer) requiredClaims.push('ver');

  async function verifyAccessToken(token) {
    let payload;

    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        clockTolerance: config.clockTolerance,
        requiredClaims,
      }));
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    if (payload.token_use !== undefined && payload.token_use !== config.tokenUse) {
      throw new UnauthorizedError('Invalid token_use');
    }

    if (payload.ver !== undefined && payload.ver !== config.tokenVer) {
      throw new UnauthorizedError('Unsupported token version');
    }

    const sub = payload[config.subjectClaim];
    if (typeof sub !== 'string' || sub.trim().length === 0) {
      throw new UnauthorizedError('Invalid token subject');
    }

    const idpGroups = readGroups(payload[config.groupsClaim]);

    return {
      sub,
      idpSub: sub,
      username: typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : undefined,
      groups: mapFederatedGroups(idpGroups, config.groupMap),
      idpGroups,
      module: typeof payload.module === 'string' ? payload.module : undefined,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
      tokenUse: typeof payload.token_use === 'string' ? payload.token_use : undefined,
      hasAntipanicButton: typeof payload.has_antipanic_button === 'boolean'
        ? payload.has_antipanic_button
        : undefined,
      authSource: 'federated',
    };
  }

  return { verifyAccessToken };
}

module.exports = { createFederatedVerifier };
