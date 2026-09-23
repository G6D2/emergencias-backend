const { Pool } = require('pg');

let pool = null;

/**
 * SSL para Postgres managed (Neon, etc.).
 * - DATABASE_SSL=false → sin SSL (Postgres local / docker-compose)
 * - default / DATABASE_SSL=true → SSL con verificación de certificado
 * - DATABASE_SSL_INSECURE=true → SSL sin verificar (solo si el pooler lo exige)
 * - DATABASE_SSL_CA → PEM del CA (opcional)
 */
function resolveSslConfig(env = process.env) {
  if (env.DATABASE_SSL === 'false') {
    return false;
  }

  if (env.DATABASE_SSL_INSECURE === 'true') {
    return { rejectUnauthorized: false };
  }

  const ssl = { rejectUnauthorized: true };
  if (typeof env.DATABASE_SSL_CA === 'string' && env.DATABASE_SSL_CA.trim()) {
    ssl.ca = env.DATABASE_SSL_CA.replace(/\\n/g, '\n');
  }
  return ssl;
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
