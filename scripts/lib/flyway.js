const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FLYWAY_IMAGE = 'flyway/flyway:10-alpine';

function buildJdbcUrl({ host, port, database }, sslmode) {
  const query = sslmode ? `?sslmode=${sslmode}` : '';
  return `jdbc:postgresql://${host}:${port}/${database}${query}`;
}

// Ejecuta Flyway dentro de un contenedor Docker efímero. Se usa Docker en vez de
// requerir el CLI de Flyway instalado localmente porque no está disponible en todos
// los entornos de desarrollo del equipo; Docker sí lo está (ver docker-compose.yml).
function runFlyway(connectionInfo, { command = 'migrate', migrationsDir, sslmode, network } = {}) {
  const jdbcUrl = buildJdbcUrl(connectionInfo, sslmode);

  // Las credenciales se pasan por --env-file (archivo temporal, borrado al final)
  // en vez de -e en el argv, para que la password no quede visible en la lista de procesos.
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
