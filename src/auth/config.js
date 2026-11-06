const { parseGroupMap, parseSubAliases } = require('./federated-claims');

const VALID_AUTH_MODES = new Set(['local', 'idp', 'hybrid']);

const DEFAULT_ISSUER = 'https://idp.citypass.local';
const DEFAULT_AUDIENCE = 'citypass-emergencias-api';
// Issuer de los tokens locales en hybrid. Tiene que ser distinto del del Login
// Federado (que hoy emite iss=https://idp.citypass.local, el mismo texto que
// el default de arriba): el `iss` es lo que decide contra qué claves se valida.
const DEFAULT_HYBRID_LOCAL_ISSUER = 'urn:citypass:emergencias:local';
const CLAIM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseStrictBoolean(env, name, defaultValue) {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

function parseClaimName(env, name, defaultValue) {
  const value = env[name] || defaultValue;
  if (!CLAIM_NAME_RE.test(value)) {
    throw new Error(`${name} must be a plain claim name (letters, digits, "_" or "-")`);
  }
  return value;
}

// El JWKS decide qué firmas valen: por http cualquiera en el medio podría
// meter su clave. http solo para un IdP de prueba en la misma máquina.
function parseJwksUri(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('IDP_JWKS_URI must be a valid URL');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('IDP_JWKS_URI must use https (http only for localhost)');
  }
  return url.href;
}

/**
 * AUTH_MODE=hybrid: tokens del Login Federado (validados contra IDP_JWKS_URI)
 * y tokens locales (firmados por este backend) a la vez.
 *
 * No mira NODE_ENV ni ALLOW_LOCAL_AUTH: elegir hybrid ya es declarar que se
 * aceptan tokens locales, así que arranca igual con NODE_ENV=production.
 */
function loadHybridConfig(env, base) {
  const local = {
    issuer: env.LOCAL_JWT_ISSUER || DEFAULT_HYBRID_LOCAL_ISSUER,
    audience: env.LOCAL_JWT_AUDIENCE || DEFAULT_AUDIENCE,
  };

  if (local.issuer === base.issuer) {
    throw new Error(
      'AUTH_MODE=hybrid needs LOCAL_JWT_ISSUER different from IDP_ISSUER (the issuer picks the keys that verify the token)'
    );
  }

  const federated = {
    issuer: base.issuer,
    audience: base.audience,
    jwksUri: parseJwksUri(base.jwksUri),
    clockTolerance: base.clockTolerance,
    tokenUse: base.expectedTokenUse,
    tokenVer: base.expectedVer,
    requireTokenUse: parseStrictBoolean(env, 'IDP_REQUIRE_TOKEN_USE', false),
    requireTokenVer: parseStrictBoolean(env, 'IDP_REQUIRE_TOKEN_VER', false),
    subjectClaim: parseClaimName(env, 'IDP_SUBJECT_CLAIM', 'sub'),
    groupsClaim: parseClaimName(env, 'IDP_GROUPS_CLAIM', 'groups'),
    groupMap: parseGroupMap(env.IDP_GROUP_MAP),
    subAliases: parseSubAliases(env.IDP_SUB_ALIASES),
  };

  return { ...base, local, federated };
}

function loadAuthConfig(env = process.env) {
  const mode = (env.AUTH_MODE || 'local').toLowerCase();

  if (!VALID_AUTH_MODES.has(mode)) {
    throw new Error(`Invalid AUTH_MODE "${mode}": use "local", "idp" or "hybrid"`);
  }

  const allowLocalInDeploy = env.ALLOW_LOCAL_AUTH === 'true';

  // Solo AUTH_MODE=local. hybrid no depende de NODE_ENV (ver loadHybridConfig).
  if (mode === 'local' && env.NODE_ENV === 'production' && !allowLocalInDeploy) {
    throw new Error(
      'AUTH_MODE=local is not allowed when NODE_ENV=production (set ALLOW_LOCAL_AUTH=true for staging pre-IdP)'
    );
  }

  const issuer = env.IDP_ISSUER || DEFAULT_ISSUER;
  const audience = env.IDP_AUDIENCE || DEFAULT_AUDIENCE;
  const jwksUri = env.IDP_JWKS_URI || 'https://idp.citypass.local/.well-known/jwks.json';
  const clockTolerance = Number(env.IDP_CLOCK_TOLERANCE_SECONDS ?? 60);
  const tokenTtlSeconds = Number(env.LOCAL_TOKEN_TTL_SECONDS ?? 900);

  if (mode !== 'local' && (!env.IDP_ISSUER || !env.IDP_AUDIENCE || !env.IDP_JWKS_URI)) {
    throw new Error(
      `AUTH_MODE=${mode} requires IDP_ISSUER, IDP_AUDIENCE and IDP_JWKS_URI`
    );
  }

  if (!Number.isFinite(clockTolerance) || clockTolerance < 0) {
    throw new Error('IDP_CLOCK_TOLERANCE_SECONDS must be a non-negative number');
  }

  if (!Number.isFinite(tokenTtlSeconds) || tokenTtlSeconds <= 0) {
    throw new Error('LOCAL_TOKEN_TTL_SECONDS must be a positive number');
  }

  const base = {
    mode,
    issuer,
    audience,
    jwksUri,
    clockTolerance,
    tokenTtlSeconds,
    expectedTokenUse: 'human',
    expectedVer: 1,
    module: env.IDP_MODULE || 'emergencias',
  };

  return mode === 'hybrid' ? loadHybridConfig(env, base) : base;
}

/**
 * Config con la que se emiten y validan los tokens locales. En local es la
 * config de siempre (IDP_ISSUER / IDP_AUDIENCE); en hybrid, issuer y audience
 * salen de LOCAL_JWT_ISSUER / LOCAL_JWT_AUDIENCE.
 */
function localTokenConfig(config) {
  return config.local ? { ...config, ...config.local } : config;
}

module.exports = { loadAuthConfig, localTokenConfig };
