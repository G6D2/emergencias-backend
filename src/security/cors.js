const { secureLog } = require('./secure-log');

const DEV_DEFAULT_ORIGIN = 'http://localhost:3001';
const RENDER_FRONTEND_ORIGIN = 'https://frontend-krds.onrender.com';

/**
 * Resuelve la lista de origins permitidos para CORS.
 *
 * - `CORS_ALLOWED_ORIGINS` (coma-separado) manda siempre que esté definida.
 * - Sin ella, en producción se exige: se loguea un warn y se permite
 *   únicamente el frontend deployado en Render (no se refleja el origin del
 *   request, a diferencia del `origin: true` anterior).
 * - Sin ella, fuera de producción, el default es el frontend local
 *   (`http://localhost:3001`).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function resolveCorsOrigins(env = process.env) {
  const raw = (env.CORS_ALLOWED_ORIGINS || '').trim();
  if (raw) {
    return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
  }

  const isProduction = env.NODE_ENV === 'production';
  if (isProduction) {
    secureLog('warn', 'CORS_ALLOWED_ORIGINS no está definida en producción', {
      fallback: RENDER_FRONTEND_ORIGIN,
    });
    return [RENDER_FRONTEND_ORIGIN];
  }

  return [DEV_DEFAULT_ORIGIN];
}

module.exports = { resolveCorsOrigins, DEV_DEFAULT_ORIGIN, RENDER_FRONTEND_ORIGIN };
