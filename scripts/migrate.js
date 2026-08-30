require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const { runFlyway } = require('./lib/flyway');
const { parseDatabaseUrl } = require('./lib/db-url');

const command = process.argv[2] || 'migrate';

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL no está definida. Copiá .env.example a .env y pegá la connection string.'
  );
  process.exit(1);
}

const connectionInfo = parseDatabaseUrl(process.env.DATABASE_URL);
const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations').replace(/\\/g, '/');
const sslmode = process.env.DATABASE_SSL === 'false' ? undefined : 'require';

// Flyway corre adentro de un contenedor. Si DATABASE_URL dice localhost,
// desde ahí localhost es el contenedor de Flyway, no el Postgres del host.
// - Si existe la red del compose, nos enganchamos y usamos el servicio "postgres".
// - Si no, en Docker Desktop (Win/Mac) host.docker.internal apunta al host.
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
        // Dentro de la red del compose el servicio escucha en 5432, no en el
        // puerto publicado al host (5434).
        connectionInfo: { ...info, host: 'postgres', port: '5432' },
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

console.log('Listo.');
