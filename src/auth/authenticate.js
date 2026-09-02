const { UnauthorizedError } = require('../errors/app-errors');
const { loadAuthConfig } = require('./config');
const { createJwtVerifier } = require('./jwt-verifier');

/**
 * Middleware: exige Authorization: Bearer <JWT> y deja la identidad en req.user.
 *
 * @param {object} [options]
 * @param {object} [options.config] - override de loadAuthConfig()
 * @param {import('jose').JWTVerifyGetKey} [options.jwks] - JWKS inyectable (tests)
 * @param {(token: string) => Promise<object>} [options.verifyAccessToken] - verifier inyectable
 */
function createAuthenticateMiddleware(options = {}) {
  const config = options.config || loadAuthConfig();
  const verifier = options.verifyAccessToken
    ? { verifyAccessToken: options.verifyAccessToken }
    : createJwtVerifier(config, options.jwks);

  return async function authenticate(req, res, next) {
    try {
      const header = req.headers.authorization;
      if (!header || typeof header !== 'string') {
        throw new UnauthorizedError('Missing Authorization header');
      }

      const [scheme, token, ...rest] = header.split(' ');
      if (scheme !== 'Bearer' || !token || rest.length > 0) {
        throw new UnauthorizedError('Invalid Authorization header');
      }

      req.user = await verifier.verifyAccessToken(token);
      next();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        next(err);
        return;
      }
      next(new UnauthorizedError('Invalid or expired token'));
    }
  };
}

module.exports = { createAuthenticateMiddleware };
