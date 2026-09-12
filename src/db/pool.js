const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL no está definida');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Neon (y otros Postgres managed) piden SSL. Con el pooler a veces hay que
      // aflojar la verificación del cert. DATABASE_SSL=false apaga el SSL para
      // Postgres local (docker-compose / tests de integración).
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
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

module.exports = { getPool, closePool };
