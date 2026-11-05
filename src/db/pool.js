const { Pool } = require('pg');
const { secureLog } = require('../security/secure-log');

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
      ssl.ca = env.DATABASE_SSL_CA.replaceAll('\\n', '\n');
    }
    return ssl;
  }

  // Default pre-demo: cifrado en tránsito sin validar el cert del pooler.
  return { rejectUnauthorized: false };
}

/**
 * true si la URL apunta al pooler de Neon (host `ep-xxx-pooler...`). Es
 * PgBouncer en modo transacción y solo acepta client_encoding, datestyle,
 * timezone, standard_conforming_strings y application_name como startup
 * parameters: cualquier otro corta TODAS las conexiones con "unsupported
 * startup parameter" (docs de Neon, Connection errors).
 */
function usesTransactionPooler(connectionString) {
  try {
    return new URL(connectionString).hostname.includes('-pooler');
  } catch {
    return false;
  }
}

/**
 * Timeouts de sesión: una query colgada o una transacción abandonada no
 * pueden retener una conexión (ni el compute de Neon) para siempre. `pg` los
 * manda como startup parameters, así que contra el pooler no van: ahí se
 * configuran por rol (ALTER ROLE ... SET statement_timeout = '10s').
 */
function resolveSessionTimeouts(connectionString) {
  if (usesTransactionPooler(connectionString)) {
    return {};
  }
  return {
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 15000,
  };
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
      // TCP keepalive: una conexión que el otro extremo dejó de responder
      // (corte de red, Neon suspendido) se detecta en vez de quedar colgada.
      keepAlive: true,
      ...resolveSessionTimeouts(process.env.DATABASE_URL),
    });

    // Un client ocioso que se corta (Neon suspende el compute, se reinicia el
    // pooler) emite 'error' en el pool: sin listener, Node lo trata como
    // excepción no capturada y tira el proceso. El pool ya lo descarta solo.
    pool.on('error', (error) => {
      secureLog('error', 'Postgres: se cortó una conexión ociosa del pool', {
        code: error.code,
        message: error.message,
      });
    });
    // Mientras un client está prestado, el pool no le escucha 'error'. La
    // query en curso ya se rechaza con ese error (y la maneja quien la hizo):
    // este listener solo evita que el evento sin listener tire el proceso.
    pool.on('connect', (client) => {
      client.on('error', () => {});
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

module.exports = { getPool, closePool, resolveSslConfig, resolveSessionTimeouts };
