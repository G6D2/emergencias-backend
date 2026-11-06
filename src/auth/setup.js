const { createLocalJWKSet, createRemoteJWKSet } = require('jose');
const { createAuthenticateMiddleware } = require('./authenticate');
const { loadAuthConfig, localTokenConfig } = require('./config');
const { createJwtVerifier } = require('./jwt-verifier');
const { createFederatedVerifier } = require('./federated-verifier');
const { createHybridVerifier } = require('./hybrid-verifier');
const { createLocalKeySet } = require('./local-keys');
const { createLocalTokenIssuer } = require('./local-token-issuer');
const { createDevAuthRoutes } = require('../routes/dev-auth.routes');

/**
 * Emisor y verifier de tokens locales (local y hybrid comparten esto).
 */
async function createLocalAuth(env, config, jwks) {
  const keys = await createLocalKeySet(env.LOCAL_JWT_PRIVATE_KEY_PEM || null);
  const verifier = createJwtVerifier(config, jwks || createLocalJWKSet({ keys: [keys.publicJwk] }));
  const issuer = createLocalTokenIssuer(keys.privateKey, config);
  return { verifier, issuer };
}

/**
 * Arma middleware + rutas según AUTH_MODE.
 * - local: emite y valida JWT con clave propia (misma forma que CityPass+)
 * - idp: valida contra JWKS del Grupo 2
 * - hybrid: las dos cosas a la vez; el `iss` del token decide cuál aplica
 *
 * @param {{
 *   env?: object,
 *   config?: object,
 *   jwks?: object,
 *   federatedJwks?: object,
 *   authUserRepository?: object|null,
 * }} [options] - `jwks` reemplaza las claves locales (local/hybrid) o el JWKS
 *   remoto (idp); `federatedJwks` reemplaza el JWKS remoto en hybrid (tests).
 */
async function createAuthSetup(options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadAuthConfig(env);

  if (config.mode === 'local') {
    const { verifier, issuer } = await createLocalAuth(env, config, options.jwks);

    return {
      mode: 'local',
      config,
      authenticate: createAuthenticateMiddleware({
        config,
        verifyAccessToken: verifier.verifyAccessToken,
      }),
      // register/login solo si hay repo de usuarios (pool disponible)
      devAuthRouter: createDevAuthRoutes(issuer, options.authUserRepository || null),
    };
  }

  if (config.mode === 'hybrid') {
    const localConfig = localTokenConfig(config);
    const { verifier: localVerifier, issuer } = await createLocalAuth(env, localConfig, options.jwks);
    const federatedVerifier = createFederatedVerifier(
      config.federated,
      options.federatedJwks || createRemoteJWKSet(new URL(config.federated.jwksUri))
    );
    const verifier = createHybridVerifier({
      local: { issuer: localConfig.issuer, verifyAccessToken: localVerifier.verifyAccessToken },
      federated: { issuer: config.federated.issuer, verifyAccessToken: federatedVerifier.verifyAccessToken },
    });

    return {
      mode: 'hybrid',
      config,
      authenticate: createAuthenticateMiddleware({
        config,
        verifyAccessToken: verifier.verifyAccessToken,
        subAliases: config.federated.subAliases,
      }),
      // Mismos endpoints locales que AUTH_MODE=local, con la misma política.
      devAuthRouter: createDevAuthRoutes(issuer, options.authUserRepository || null),
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
