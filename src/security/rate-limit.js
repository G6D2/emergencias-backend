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

// El frontend habla con este backend a través de su BFF, así que TODOS los
// usuarios llegan con la misma IP: un límite por IP es en la práctica un cupo
// global para toda la ciudad. Donde hay usuario autenticado la clave es el
// `sub` del JWT y la IP queda solo como respaldo.
function keyByUser(req) {
  const sub = req.user && typeof req.user.sub === 'string' ? req.user.sub : '';
  return sub ? `sub:${sub}` : `ip:${req.ip}`;
}

// Logins: todavía no hay `req.user`, pero el cuerpo dice qué cuenta se está
// usando. Clave por cuenta para que un usuario (o alguien probando contraseñas
// contra una cuenta) no deje sin login a todos los que comparten la IP del BFF.
// Sin campo en el cuerpo cae a la IP.
function keyByBodyField(field) {
  return (req) => {
    const raw = req.body && typeof req.body[field] === 'string' ? req.body[field] : '';
    const value = raw.trim().toLowerCase();
    return value ? `${field}:${value}` : `ip:${req.ip}`;
  };
}

function buildLimiter(
  { windowMs, max, message, keyGenerator, skipFailedRequests = false, skipSuccessfulRequests = false },
  env = process.env
) {
  if (!isRateLimitEnabled(env)) {
    return (req, res, next) => next();
  }

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    skipFailedRequests,
    skipSuccessfulRequests,
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

/**
 * POST /auth/dev/login: 10 req/min por `sub` pedido (con DEV_LOGIN_STRICT,
 * por cuenta demo de la allowlist), no un cupo global para todos los que
 * entran por el BFF.
 */
function createDevLoginRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 10,
      message: 'Demasiados intentos de login. Probá de nuevo en un minuto.',
      keyGenerator: keyByBodyField('sub'),
    },
    env
  );
}

/**
 * POST /auth/login y /auth/dev/login, ANTES del límite por cuenta: red por IP
 * contra un flood que rota cuentas, lo bastante ancha (300 req/min) para no
 * castigar a todos los usuarios que llegan con la IP del BFF.
 */
function createAuthLoginIpRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 300,
      message: 'Demasiadas solicitudes. Probá de nuevo en un minuto.',
    },
    env
  );
}

/**
 * POST /api/panic-button: 5 req/min por ciudadano (`sub` del JWT; un ciudadano
 * no dispara 5 pánicos por minuto). Va DESPUÉS de `authenticate` en la ruta
 * para tener `req.user`. Los requests fallidos (400, 503...) no cuentan: si el
 * alta falla, el reintento del ciudadano no le consume el cupo.
 */
function createPanicButtonRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 5,
      message: 'Demasiadas activaciones del botón de pánico. Probá de nuevo en un minuto.',
      keyGenerator: keyByUser,
      skipFailedRequests: true,
    },
    env
  );
}

/**
 * POST /api/panic-button, ANTES de `authenticate`: red por IP para frenar un
 * flood (con o sin token) sin castigar a los ciudadanos que comparten la IP
 * del BFF. 300 req/min por IP.
 */
function createPanicButtonIpRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 300,
      message: 'Demasiadas solicitudes. Probá de nuevo en un minuto.',
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

/**
 * POST /auth/login: 20 intentos fallidos/min por email. Los logins exitosos no
 * cuentan: el cupo lo gastan solo las credenciales incorrectas (fuerza bruta
 * contra esa cuenta). Antes la clave era la IP, que detrás del BFF es la misma
 * para todos: 20 contraseñas mal tipeadas en un minuto dejaban sin login a
 * toda la ciudad.
 */
function createAuthLoginRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 20,
      message: 'Demasiados intentos. Probá de nuevo en un minuto.',
      keyGenerator: keyByBodyField('email'),
      skipSuccessfulRequests: true,
    },
    env
  );
}

/**
 * POST /auth/register: 20 req/min por IP. Acá los exitosos SÍ cuentan: cada
 * alta crea una cuenta, y no contarlas dejaría crear cuentas sin tope.
 */
function createAuthRegisterRateLimiter(env = process.env) {
  return buildLimiter(
    {
      windowMs: 60 * 1000,
      max: 20,
      message: 'Demasiados intentos. Probá de nuevo en un minuto.',
    },
    env
  );
}

module.exports = {
  isRateLimitEnabled,
  createDevLoginRateLimiter,
  createAuthLoginIpRateLimiter,
  createPanicButtonRateLimiter,
  createPanicButtonIpRateLimiter,
  createCitizenProfileMutationRateLimiter,
  createAuthLoginRateLimiter,
  createAuthRegisterRateLimiter,
};
