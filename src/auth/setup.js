const { createLocalJWKSet } = require('jose');
const { createAuthenticateMiddleware } = require('./authenticate');
const { loadAuthConfig } = require('./config');
const { createJwtVerifier } = require('./jwt-verifier');
const { createLocalKeySet } = require('./local-keys');
const { createLocalTokenIssuer } = require('./local-token-issuer');
const { createDevAuthRoutes } = require('../routes/dev-auth.routes');

/**
 * Arma middleware + rutas según AUTH_MODE.
 * - local: emite y valida JWT con clave propia (misma forma que CityPass+)
 * - idp: valida contra JWKS del Grupo 2
 */
async function createAuthSetup(options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadAuthConfig(env);

  if (config.mode === 'local') {
    const keys = await createLocalKeySet(env.LOCAL_JWT_PRIVATE_KEY_PEM || null);
    const jwks = options.jwks || createLocalJWKSet({ keys: [keys.publicJwk] });
    const verifier = createJwtVerifier(config, jwks);
    const issuer = createLocalTokenIssuer(keys.privateKey, config);

    return {
      mode: 'local',
      config,
      authenticate: createAuthenticateMiddleware({
        config,
        verifyAccessToken: verifier.verifyAccessToken,
      }),
      devAuthRouter: createDevAuthRoutes(issuer),
    };
  }

  return {
    mode: 'idp',
    config,
    authenticate: createAuthenticateMiddleware({
      config,
      jwks: options.jwks,
    }),
    devAuthRouter: null,
  };
}

module.exports = { createAuthSetup };
