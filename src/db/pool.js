const { Pool } = require('pg');

let pool = null;

/**
 * SSL para Postgres managed (Neon, etc.).
 * - DATABASE_SSL=false → sin SSL (Postgres local / docker-compose)
 * - default → SSL con rejectUnauthorized: false (compatible con pooler Neon;
 *   se endurece post-demo con DATABASE_SSL_VERIFY=true)
 * - DATABASE_SSL_VERIFY=true → verifica el certificado del servidor
 * - DATABASE_SSL_CA → PEM del CA (solo con VERIFY)
 */
function resolveSslConfig(env = process.env) {
  if (env.DATABASE_SSL === 'false') {
    return false;
  }

  if (env.DATABASE_SSL_VERIFY === 'true') {
    const ssl = { rejectUnauthorized: true };
    if (typeof env.DATABASE_SSL_CA === 'string' && env.DATABASE_SSL_CA.trim()) {
      ssl.ca = env.DATABASE_SSL_CA.replace(/\\n/g, '\n');
    }
    return ssl;
  }

  // Default pre-demo: cifrado en tránsito sin validar el cert del pooler.
  return { rejectUnauthorized: false };
}

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL no está definida');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: resolveSslConfig(),
      // Sin límites explícitos, `pg` deja el pool crecer sin cota y las
      // conexiones colgadas nunca se liberan: un pico de tráfico (o un pico
      // de pánicos) puede agotar las conexiones del Postgres compartido.
      max: Number.parseInt(process.env.DB_POOL_MAX, 10) || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, closePool, resolveSslConfig };
