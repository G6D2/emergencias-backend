const { generateKeyPairSync, randomUUID } = require('crypto');
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { createAuthSetup } = require('../../auth/setup');
const { localTokenConfig } = require('../../auth/config');
const { createLocalKeySet, LOCAL_KEY_ID } = require('../../auth/local-keys');
const { createLocalTokenIssuer } = require('../../auth/local-token-issuer');

// AUTH_MODE=hybrid real para tests: el mismo createAuthSetup que arma
// src/index.js. Lo único que cambia es el JWKS del Login Federado: en vez de
// bajar https://api.citypass-login.pp.ua/.well-known/jwks.json se usa uno en
// memoria (createLocalJWKSet) con la misma forma (RSA, RS256, un kid) y un
// par de claves generado acá, que hace de IdP del Grupo 2.

// iss que emite hoy el Login Federado según el contrato del Grupo 2
// (carlos-illobre/citypass-event-gateway, docs/externo/GRUPO-2-AUTENTICACION.md).
const FEDERATED_ISSUER = 'https://idp.citypass.local';
const FEDERATED_AUDIENCE = 'citypass-emergencias-api';
const FEDERATED_KID = 'login-federado-test';

const HYBRID_AUTH_ENV = Object.freeze({
  AUTH_MODE: 'hybrid',
  NODE_ENV: 'test',
  IDP_ISSUER: FEDERATED_ISSUER,
  IDP_AUDIENCE: FEDERATED_AUDIENCE,
  IDP_JWKS_URI: 'https://api.citypass-login.pp.ua/.well-known/jwks.json',
  IDP_MODULE: 'emergencias',
  LOCAL_TOKEN_TTL_SECONDS: '900',
});

function generatePkcs8Pem() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

/**
 * IdP federado falso. `sign(claims)` arma un token humano con la forma del
 * contrato del Grupo 2; pasar un claim en `undefined` lo saca del token.
 */
async function createFakeFederatedIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: FEDERATED_KID, alg: 'RS256', use: 'sig' });

  async function sign(claims = {}, { key = privateKey, kid = FEDERATED_KID } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: FEDERATED_ISSUER,
      sub: 'U000123',
      aud: [FEDERATED_AUDIENCE],
      token_use: 'human',
      ver: 1,
      preferred_username: 'jperez',
      module: 'emergencias',
      groups: [],
      iat: now,
      exp: now + 900,
      jti: randomUUID(),
      ...claims,
    };
    return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).sign(key);
  }

  return { jwks: createLocalJWKSet({ keys: [jwk] }), sign };
}

/**
 * @param {object} [extraEnv] - variables extra (IDP_SUB_ALIASES, IDP_GROUP_MAP...)
 * @param {{ authUserRepository?: object }} [options]
 */
async function createHybridJwtAuth(extraEnv = {}, options = {}) {
  const pem = generatePkcs8Pem();
  const idp = await createFakeFederatedIdp();
  const auth = await createAuthSetup({
    env: { ...HYBRID_AUTH_ENV, LOCAL_JWT_PRIVATE_KEY_PEM: pem, ...extraEnv },
    federatedJwks: idp.jwks,
    authUserRepository: options.authUserRepository || null,
  });

  const localConfig = localTokenConfig(auth.config);
  const { privateKey: localPrivateKey } = await createLocalKeySet(pem);
  const localIssuer = createLocalTokenIssuer(localPrivateKey, localConfig);

  // Token local tal como lo emite /auth/login o /auth/dev/login en hybrid.
  async function localToken({ sub, groups = [], ...claims }) {
    const { access_token: token } = await localIssuer.issueAccessToken({ sub, groups, ...claims });
    return token;
  }

  // Token firmado con la clave local y claims a mano (para romper el contrato).
  async function signLocal(claims) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: LOCAL_KEY_ID })
      .sign(localPrivateKey);
  }

  return {
    auth,
    localConfig,
    authenticate: auth.authenticate,
    devAuthRouter: auth.devAuthRouter,
    federatedToken: idp.sign,
    localToken,
    signLocal,
  };
}

module.exports = {
  FEDERATED_ISSUER,
  FEDERATED_AUDIENCE,
  HYBRID_AUTH_ENV,
  createFakeFederatedIdp,
  createHybridJwtAuth,
  generatePkcs8Pem,
};
