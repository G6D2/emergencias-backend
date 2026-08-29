/**
 * Entry point de migrations que usa el pipeline de CI/CD.
 * Delega a Flyway (`scripts/migrate.js` + `db/migrations/`).
 *
 * El schema vive en `db/migrations/V1__create_emergencias.sql`
 * (tabla `emergencies`, latitude/longitude, status CREATED).
 */
require('dotenv').config();

const path = require('path');
const { spawnSync } = require('child_process');
const { runFlyway } = require('../../scripts/lib/flyway');
const { parseDatabaseUrl } = require('../../scripts/lib/db-url');

const command = process.argv[2] || 'migrate';

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL no está definida. Copiá .env.example a .env y pegá la connection string.'
  );
  process.exit(1);
}

const connectionInfo = parseDatabaseUrl(process.env.DATABASE_URL);
const migrationsDir = path.resolve(__dirname, '..', '..', 'db', 'migrations').replace(/\\/g, '/');
const sslmode = process.env.DATABASE_SSL === 'false' ? undefined : 'require';

function resolveFlywayTarget(info) {
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!localHosts.has(info.host)) {
    return { connectionInfo: info };
  }

  const networks = spawnSync('docker', ['network', 'ls', '--format', '{{.Name}}'], {
    encoding: 'utf8',
  });
  if (networks.status === 0) {
    const composeNet = networks.stdout
      .split(/\r?\n/)
      .map((n) => n.trim())
      .find((n) => n.includes('emergencias') && n.endsWith('_default'));
    if (composeNet) {
      return {
        connectionInfo: { ...info, host: 'postgres' },
        network: composeNet,
      };
    }
  }

  return {
    connectionInfo: { ...info, host: 'host.docker.internal' },
  };
}

const target = resolveFlywayTarget(connectionInfo);

console.log(
  `Ejecutando "flyway ${command}" contra ${target.connectionInfo.host}:${target.connectionInfo.port}/${target.connectionInfo.database}...`
);

runFlyway(target.connectionInfo, {
  command,
  migrationsDir,
  sslmode,
  network: target.network,
});

console.log('All migrations up to date');
