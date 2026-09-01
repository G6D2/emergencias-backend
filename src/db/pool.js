const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL no está definida');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Supabase requiere SSL; el certificado del pooler no siempre valida contra la
      // CA por defecto de Node, por eso se relaja la verificación (patrón estándar
      // recomendado por Supabase para node-postgres). DATABASE_SSL=false desactiva
      // SSL por completo para Postgres locales (ej. tests de integración).
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
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
