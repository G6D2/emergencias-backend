const { parseDatabaseUrl } = require('../../../scripts/lib/db-url');

// Los tests de integración escriben y borran filas (algunas suites hacen
// DELETE sin WHERE sobre tablas como eventos_procesados). Correrlos contra
// una base compartida o productiva (Neon) la rompe. Por eso TEST_DATABASE_URL
// solo se acepta si apunta a la máquina local; para una base remota
// descartable (un branch de Neon solo para tests) hay que pedirlo explícito
// con ALLOW_REMOTE_TEST_DB=true.
const LOCAL_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

function isLocalHost(host) {
  const normalized = String(host || '').toLowerCase();
  return LOCAL_HOSTNAMES.has(normalized)
    || normalized.endsWith('.localhost')
    || /^127(\.\d{1,3}){3}$/.test(normalized);
}

/**
 * Lanza si la URL no es local y no se habilitó ALLOW_REMOTE_TEST_DB=true.
 * Devuelve { host, remote } para que el caller pueda avisar.
 */
function assertSafeTestDatabaseUrl(databaseUrl, env = process.env) {
  const { host } = parseDatabaseUrl(databaseUrl);

  if (isLocalHost(host)) {
    return { host, remote: false };
  }

  if (env.ALLOW_REMOTE_TEST_DB === 'true') {
    return { host, remote: true };
  }

  throw new Error(
    `TEST_DATABASE_URL apunta a "${host}", que no es una base local. `
    + 'Los tests de integración borran filas (hay DELETE sin WHERE), así que no se corren '
    + 'contra una base remota. Si es una base descartable solo para tests, exportá '
    + 'ALLOW_REMOTE_TEST_DB=true; si no, sacá TEST_DATABASE_URL y se levanta un Postgres en Docker.'
  );
}

module.exports = { assertSafeTestDatabaseUrl, isLocalHost };
