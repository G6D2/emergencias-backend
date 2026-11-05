const { ValidationError } = require('../errors/app-errors');

/** Grupos que el login de desarrollo puede emitir. */
const ALLOWED_DEV_GROUPS = new Set(['citizen', 'dispatcher', 'officer']);

/**
 * Sujetos demo permitidos cuando DEV_LOGIN_STRICT / production.
 * Claims fijos: el cliente no elige groups a mano.
 */
const DEV_LOGIN_ALLOWLIST = Object.freeze({
  U000042: {
    preferred_username: 'ciudadano',
    groups: ['citizen'],
    has_antipanic_button: false,
  },
  'CIT-JuanPanico': {
    preferred_username: 'JuanPanico',
    groups: ['citizen'],
    has_antipanic_button: true,
  },
  'CIT-LuciaTranquila': {
    preferred_username: 'LuciaTranquila',
    groups: ['citizen'],
    has_antipanic_button: false,
  },
  'DISP-Demo001': {
    preferred_username: 'Dispatcher Demo',
    groups: ['dispatcher'],
    has_antipanic_button: false,
  },
  // Oficiales demo: el sub es el id del catálogo `officers` (V11), porque el
  // permiso de avanzar estado compara sub === assigned_officer_id
  // (canAdvanceEmergencyStatus). Dos oficiales permiten demostrar que uno no
  // puede tocar la emergencia del otro.
  'of-001': {
    preferred_username: 'Oficial Carlos Gómez',
    groups: ['officer'],
    has_antipanic_button: false,
  },
  'of-002': {
    preferred_username: 'Oficial Mariana López',
    groups: ['officer'],
    has_antipanic_button: false,
  },
});

function isDevLoginStrict(env = process.env) {
  if (env.DEV_LOGIN_STRICT === 'true') return true;
  if (env.DEV_LOGIN_STRICT === 'false') return false;
  // Staging / demos públicas con ALLOW_LOCAL_AUTH: no inventar roles libres.
  return env.NODE_ENV === 'production';
}

/**
 * Resuelve claims de POST /auth/dev/login.
 * - Modo estricto: solo allowlist (groups/username fijos).
 * - Modo laxo (dev/test): acepta sub libre; groups filtrados al catálogo.
 */
function resolveDevLoginClaims(body = {}, env = process.env) {
  const sub = typeof body.sub === 'string' ? body.sub.trim() : '';
  if (!sub) {
    throw new ValidationError('sub is required');
  }

  if (isDevLoginStrict(env)) {
    const entry = DEV_LOGIN_ALLOWLIST[sub];
    if (!entry) {
      throw new ValidationError(
        'Demo subject not allowed. Use a seeded demo sub or AUTH_MODE=idp.'
      );
    }
    return {
      sub,
      preferred_username: entry.preferred_username,
      groups: [...entry.groups],
      has_antipanic_button: entry.has_antipanic_button,
    };
  }

  const rawGroups = Array.isArray(body.groups) ? body.groups : ['citizen'];
  const groups = rawGroups
    .filter((g) => typeof g === 'string' && ALLOWED_DEV_GROUPS.has(g));

  let hasAntipanic;
  if (typeof body.has_antipanic_button === 'boolean') {
    hasAntipanic = body.has_antipanic_button;
  } else if (typeof body.hasAntipanicButton === 'boolean') {
    hasAntipanic = body.hasAntipanicButton;
  }

  return {
    sub,
    preferred_username:
      typeof body.preferred_username === 'string' ? body.preferred_username : undefined,
    groups: groups.length > 0 ? groups : ['citizen'],
    has_antipanic_button: hasAntipanic,
  };
}

module.exports = {
  resolveDevLoginClaims,
  isDevLoginStrict,
  DEV_LOGIN_ALLOWLIST,
  ALLOWED_DEV_GROUPS,
};
