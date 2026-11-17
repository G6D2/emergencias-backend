const { UnauthorizedError } = require('../errors/app-errors');
const { loadAuthConfig } = require('./config');
const { applySubAlias } = require('./federated-claims');
const { createJwtVerifier } = require('./jwt-verifier');
const { logTokenRejection } = require('./token-rejection-log');

/**
 * Middleware: exige Authorization: Bearer <JWT> y deja la identidad en req.user.
 *
 * Con IDP_SUB_ALIASES (AUTH_MODE=hybrid), a los tokens del Login Federado se
 * les reemplaza el sub por el id interno (ej. 'of-001') antes de seguir: todo
 * lo que usa req.user.sub (oficial asignado, auditoría, rate limit) ve el id
 * interno, y el sub federado queda en req.user.idpSub.
 *
 * @param {object} [options]
 * @param {object} [options.config] - override de loadAuthConfig()
 * @param {import('jose').JWTVerifyGetKey} [options.jwks] - JWKS inyectable (tests)
 * @param {(token: string) => Promise<object>} [options.verifyAccessToken] - verifier inyectable
 * @param {Map<string, string>} [options.subAliases] - sub federado → id interno
 */
function createAuthenticateMiddleware(options = {}) {
  const config = options.config || loadAuthConfig();
  const verifier = options.verifyAccessToken
    ? { verifyAccessToken: options.verifyAccessToken }
    : createJwtVerifier(config, options.jwks);
  const subAliases = options.subAliases || null;

  return async function authenticate(req, res, next) {
    try {
      const header = req.headers.authorization;
      if (!header || typeof header !== 'string') {
        throw new UnauthorizedError('Falta el header Authorization');
      }

      const [scheme, token, ...rest] = header.split(' ');
      if (scheme !== 'Bearer' || !token || rest.length > 0) {
        throw new UnauthorizedError('Header Authorization inválido');
      }

      req.user = applySubAlias(await verifier.verifyAccessToken(token), subAliases);
      next();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        next(err);
        return;
      }
      // Un error que no es UnauthorizedError no es un token malo: es una falla
      // inesperada del verifier (un bug o una dependencia caída). Se responde
      // 401 igual, pero queda en el log en vez de perderse.
      logTokenRejection('authenticate', err);
      next(new UnauthorizedError('Token inválido o vencido'));
    }
  };
}

module.exports = { createAuthenticateMiddleware };
