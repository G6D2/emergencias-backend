const { generateKeyPairSync } = require('crypto');
const { createAuthSetup } = require('../../auth/setup');
const { createLocalKeySet } = require('../../auth/local-keys');
const { createLocalTokenIssuer } = require('../../auth/local-token-issuer');

// Auth local real para tests: el middleware `authenticate` es el mismo que
// arma src/index.js (createAuthSetup con AUTH_MODE=local) y los tokens salen
// del emisor de producción (local-token-issuer.js), firmados RS256 con la
// misma clave que valida el JWKS del middleware. Nada de stubs: un token mal
// firmado, vencido o sin los claims del contrato da 401 igual que en prod.
//
// Se fija LOCAL_JWT_PRIVATE_KEY_PEM para poder construir el emisor por fuera
// del router de /auth/dev/login: ese endpoint, en modo laxo, convierte un
// `groups: []` en ['citizen'], y la matriz de autorización necesita poder
// emitir un token válido sin ningún grupo.
const TEST_AUTH_ENV = Object.freeze({
  AUTH_MODE: 'local',
  NODE_ENV: 'test',
  IDP_ISSUER: 'https://idp.citypass.local',
  IDP_AUDIENCE: 'citypass-emergencias-api',
  IDP_MODULE: 'emergencias',
  LOCAL_TOKEN_TTL_SECONDS: '900',
});

async function createLocalJwtAuth() {
  const { privateKey: pem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const auth = await createAuthSetup({
    env: { ...TEST_AUTH_ENV, LOCAL_JWT_PRIVATE_KEY_PEM: pem },
  });
  const keys = await createLocalKeySet(pem);
  const issuer = createLocalTokenIssuer(keys.privateKey, auth.config);

  async function tokenFor({ sub, groups = [], ...claims }) {
    const { access_token: token } = await issuer.issueAccessToken({ sub, groups, ...claims });
    return token;
  }

  async function bearerFor(identity) {
    return `Bearer ${await tokenFor(identity)}`;
  }

  return {
    authenticate: auth.authenticate,
    devAuthRouter: auth.devAuthRouter,
    authMode: auth.mode,
    tokenFor,
    bearerFor,
  };
}

module.exports = { createLocalJwtAuth, TEST_AUTH_ENV };
