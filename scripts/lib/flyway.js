const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FLYWAY_IMAGE = 'flyway/flyway:10-alpine';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function buildJdbcUrl({ host, port, database }, sslmode) {
  const query = sslmode ? `?sslmode=${sslmode}` : '';
  return `jdbc:postgresql://${host}:${port}/${database}${query}`;
}

function findComposeNetwork() {
  const networks = spawnSync('docker', ['network', 'ls', '--format', '{{.Name}}'], {
    encoding: 'utf8',
  });
  if (networks.status !== 0) {
    return undefined;
  }
  return networks.stdout
    .split(/\r?\n/)
    .map((n) => n.trim())
    .find((n) => n.includes('emergencias') && n.endsWith('_default'));
}

// Flyway corre adentro de un contenedor. Si DATABASE_URL dice localhost,
// desde ahí localhost es el contenedor de Flyway, no el Postgres del host.
// - Si existe la red del compose, nos enganchamos y usamos el servicio "postgres".
// - En Linux (CI) --network host: el service de GitHub Actions publica 5432 en
//   127.0.0.1 del runner; host.docker.internal/host-gateway no llega a ese bind.
// - En Docker Desktop (Win/Mac) host.docker.internal apunta al host.
function resolveFlywayTarget(info) {
  if (!LOCAL_HOSTS.has(info.host)) {
    return { connectionInfo: info };
  }

  const composeNet = findComposeNetwork();
  if (composeNet) {
    return {
      connectionInfo: { ...info, host: 'postgres', port: '5432' },
      network: composeNet,
    };
  }

  if (process.platform === 'linux') {
    return {
      connectionInfo: { ...info, host: '127.0.0.1' },
      network: 'host',
    };
  }

  return {
    connectionInfo: { ...info, host: 'host.docker.internal' },
  };
}

function runFlyway(connectionInfo, { command = 'migrate', migrationsDir, sslmode, network } = {}) {
  const target =
    network === undefined ? resolveFlywayTarget(connectionInfo) : { connectionInfo, network };
  const jdbcUrl = buildJdbcUrl(target.connectionInfo, sslmode);

  console.log(
    `Ejecutando "flyway ${command}" contra ${target.connectionInfo.host}:${target.connectionInfo.port}/${target.connectionInfo.database}...`
  );

  // Las credenciales van por --env-file (archivo temporal que borramos después)
  // y no por -e en el argv, así la password no queda a la vista en la lista de procesos.
  const envFile = path.join(os.tmpdir(), `flyway-env-${process.pid}-${process.hrtime.bigint()}.env`);
  fs.writeFileSync(
    envFile,
    [
      `FLYWAY_URL=${jdbcUrl}`,
      `FLYWAY_USER=${target.connectionInfo.user}`,
      `FLYWAY_PASSWORD=${target.connectionInfo.password}`,
      'FLYWAY_CONNECT_RETRIES=15',
    ].join('\n'),
    { mode: 0o600 }
  );

  const dockerArgs = ['run', '--rm', '--env-file', envFile];
  if (target.network) {
    dockerArgs.push('--network', target.network);
  } else if (target.connectionInfo.host === 'host.docker.internal') {
    dockerArgs.push('--add-host', 'host.docker.internal:host-gateway');
  }
  dockerArgs.push('-v', `${migrationsDir}:/flyway/sql`, FLYWAY_IMAGE, command);

  try {
    const result = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`flyway ${command} terminó con código ${result.status}`);
    }
  } finally {
    fs.unlinkSync(envFile);
  }
}

module.exports = { runFlyway, resolveFlywayTarget };
