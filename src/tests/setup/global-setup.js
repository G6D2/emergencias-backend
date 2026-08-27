const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runFlyway } = require('../../../scripts/lib/flyway');
const { parseDatabaseUrl } = require('../../../scripts/lib/db-url');

const STATE_FILE = path.join(os.tmpdir(), 'emergencias-backend-test-db.json');
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'db', 'migrations').replace(/\\/g, '/');

function sh(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" falló: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function waitForPostgres(containerName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres']);
    if (result.status === 0) return;
    if (Date.now() > deadline) {
      throw new Error('Timeout esperando a que Postgres de test esté listo');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

module.exports = async function globalSetup() {
  // Si el desarrollador ya apunta a una base de test propia (ej. un branch de
  // Supabase dedicado a tests), se usa esa y no se orquesta ningún contenedor.
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.DATABASE_SSL = process.env.DATABASE_SSL || 'false';
    const connectionInfo = parseDatabaseUrl(process.env.TEST_DATABASE_URL);
    runFlyway(connectionInfo, {
      command: 'migrate',
      migrationsDir: MIGRATIONS_DIR,
      sslmode: process.env.DATABASE_SSL === 'false' ? undefined : 'require',
    });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ external: true }));
    return;
  }

  const runId = `${process.pid}-${process.hrtime.bigint()}`;
  const networkName = `emergencias-test-net-${runId}`;
  const containerName = `emergencias-test-pg-${runId}`;
  const dbUser = 'postgres';
  const dbPassword = 'test-password';
  const dbName = 'emergencias_test';

  sh('docker', ['network', 'create', networkName]);

  sh('docker', [
    'run', '-d',
    '--name', containerName,
    '--network', networkName,
    '-e', `POSTGRES_USER=${dbUser}`,
    '-e', `POSTGRES_PASSWORD=${dbPassword}`,
    '-e', `POSTGRES_DB=${dbName}`,
    '-p', '0:5432',
    'postgres:16-alpine',
  ]);

  fs.writeFileSync(STATE_FILE, JSON.stringify({ external: false, containerName, networkName }));

  await waitForPostgres(containerName, 30000);

  const portOutput = sh('docker', ['port', containerName, '5432/tcp']);
  const hostPort = portOutput.split(':').pop().trim();

  runFlyway(
    { host: containerName, port: '5432', database: dbName, user: dbUser, password: dbPassword },
    { command: 'migrate', migrationsDir: MIGRATIONS_DIR, network: networkName }
  );

  process.env.DATABASE_URL = `postgresql://${dbUser}:${dbPassword}@localhost:${hostPort}/${dbName}`;
  process.env.DATABASE_SSL = 'false';
};
