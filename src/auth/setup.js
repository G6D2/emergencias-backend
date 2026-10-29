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

  const isDev = env.NODE_ENV !== 'production';
  let devAuthRouter = null;
  let localJwks = null;

  if (config.mode === 'local' || isDev) {
    const keys = await createLocalKeySet(env.LOCAL_JWT_PRIVATE_KEY_PEM || null);
    localJwks = options.jwks || createLocalJWKSet({ keys: [keys.publicJwk] });
    const issuer = createLocalTokenIssuer(keys.privateKey, config);
    devAuthRouter = createDevAuthRoutes(issuer);
  }

  if (config.mode === 'local') {
    const verifier = createJwtVerifier(config, localJwks);

    return {
      mode: 'local',
      config,
      authenticate: createAuthenticateMiddleware({
        config,
        verifyAccessToken: verifier.verifyAccessToken,
      }),
      devAuthRouter,
    };
  }

  const verifier = createJwtVerifier(config, options.jwks, isDev ? localJwks : null);

  return {
    mode: 'idp',
    config,
    authenticate: createAuthenticateMiddleware({
      config,
      verifyAccessToken: verifier.verifyAccessToken,
    }),
    devAuthRouter,
  };
}

module.exports = { createAuthSetup };
