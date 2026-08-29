const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FLYWAY_IMAGE = 'flyway/flyway:10-alpine';

function buildJdbcUrl({ host, port, database }, sslmode) {
  const query = sslmode ? `?sslmode=${sslmode}` : '';
  return `jdbc:postgresql://${host}:${port}/${database}${query}`;
}

// Corre Flyway adentro de un contenedor Docker efímero. Usamos Docker en vez
// de pedir el CLI de Flyway instalado, porque no todo el mundo lo tiene; Docker sí (ver docker-compose.yml).
function runFlyway(connectionInfo, { command = 'migrate', migrationsDir, sslmode, network } = {}) {
  const jdbcUrl = buildJdbcUrl(connectionInfo, sslmode);

  // Las credenciales van por --env-file (archivo temporal que borramos después)
  // y no por -e en el argv, así la password no queda a la vista en la lista de procesos.
  const envFile = path.join(os.tmpdir(), `flyway-env-${process.pid}-${process.hrtime.bigint()}.env`);
  fs.writeFileSync(
    envFile,
    [
      `FLYWAY_URL=${jdbcUrl}`,
      `FLYWAY_USER=${connectionInfo.user}`,
      `FLYWAY_PASSWORD=${connectionInfo.password}`,
      'FLYWAY_CONNECT_RETRIES=15',
    ].join('\n'),
    { mode: 0o600 }
  );

  const dockerArgs = ['run', '--rm', '--env-file', envFile];
  if (network) {
    dockerArgs.push('--network', network);
  } else if (connectionInfo.host === 'host.docker.internal') {
    // En Linux (CI) hace falta mapear el host; en Docker Desktop Win/Mac ya existe.
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

module.exports = { runFlyway };
