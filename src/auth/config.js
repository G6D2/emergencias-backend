const VALID_AUTH_MODES = new Set(['local', 'idp']);

function loadAuthConfig(env = process.env) {
  const mode = (env.AUTH_MODE || 'local').toLowerCase();

  if (!VALID_AUTH_MODES.has(mode)) {
    throw new Error(`Invalid AUTH_MODE "${mode}": use "local" or "idp"`);
  }

  const allowLocalInDeploy = env.ALLOW_LOCAL_AUTH === 'true';

  if (mode === 'local' && env.NODE_ENV === 'production' && !allowLocalInDeploy) {
    throw new Error(
      'AUTH_MODE=local is not allowed when NODE_ENV=production (set ALLOW_LOCAL_AUTH=true for staging pre-IdP)'
    );
  }

  const issuer = env.IDP_ISSUER || 'https://idp.citypass.local';
  const audience = env.IDP_AUDIENCE || 'citypass-emergencias-api';
  const jwksUri = env.IDP_JWKS_URI || 'https://idp.citypass.local/.well-known/jwks.json';
  const clockTolerance = Number(env.IDP_CLOCK_TOLERANCE_SECONDS ?? 60);
  const tokenTtlSeconds = Number(env.LOCAL_TOKEN_TTL_SECONDS ?? 900);

  if (mode === 'idp' && (!env.IDP_ISSUER || !env.IDP_AUDIENCE || !env.IDP_JWKS_URI)) {
    throw new Error(
      'AUTH_MODE=idp requires IDP_ISSUER, IDP_AUDIENCE and IDP_JWKS_URI'
    );
  }

  if (!Number.isFinite(clockTolerance) || clockTolerance < 0) {
    throw new Error('IDP_CLOCK_TOLERANCE_SECONDS must be a non-negative number');
  }

  if (!Number.isFinite(tokenTtlSeconds) || tokenTtlSeconds <= 0) {
    throw new Error('LOCAL_TOKEN_TTL_SECONDS must be a positive number');
  }

  return {
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
}

module.exports = { loadAuthConfig };
