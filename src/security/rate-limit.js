const rateLimit = require('express-rate-limit');
const { secureLog } = require('./secure-log');

/**
 * RATE_LIMIT_ENABLED=false apaga el rate limiting por completo (se usa en
 * tests, que reutilizan la misma app/IP para muchos requests seguidos).
 * Cualquier otro valor (incluida la ausencia de la variable) lo deja activo.
 */
function isRateLimitEnabled(env = process.env) {
  return env.RATE_LIMIT_ENABLED !== 'false';
}

function buildLimiter({ windowMs, max, message }, env = process.env) {
  if (!isRateLimitEnabled(env)) {
    return (req, res, next) => next();
  }

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      secureLog('warn', 'TooManyRequests', {
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
      res.status(429).json({ error: 'TooManyRequests', message });
    },
  });
}

/** POST /auth/dev/login: 10 req/min por IP. */
function createDevLoginRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 10,
      message: 'Demasiados intentos de login. Probá de nuevo en un minuto.',
    },
    env
  );
}

/** POST /api/panic-button: 5 req/min por IP (un ciudadano no dispara 5 pánicos por minuto). */
function createPanicButtonRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 5,
      message: 'Demasiadas activaciones del botón de pánico. Probá de nuevo en un minuto.',
    },
    env
  );
}

/** PUT profile / mutaciones de ubicaciones guardadas: 30 req/min por IP. */
function createCitizenProfileMutationRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 30,
      message: 'Demasiadas modificaciones al perfil. Probá de nuevo en un minuto.',
    },
    env
  );
}

module.exports = {
  isRateLimitEnabled,
  createDevLoginRateLimiter,
  createPanicButtonRateLimiter,
  createCitizenProfileMutationRateLimiter,
};
