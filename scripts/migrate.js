require('dotenv').config();
const path = require('path');
const { runFlyway } = require('./lib/flyway');
const { parseDatabaseUrl } = require('./lib/db-url');

const command = process.argv[2] || 'migrate';

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL no está definida. Copiá .env.example a .env y completá la connection string de Supabase.'
  );
  process.exit(1);
}

const connectionInfo = parseDatabaseUrl(process.env.DATABASE_URL);
const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations').replace(/\\/g, '/');
const sslmode = process.env.DATABASE_SSL === 'false' ? undefined : 'require';

console.log(`Ejecutando "flyway ${command}" contra ${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}...`);

runFlyway(connectionInfo, { command, migrationsDir, sslmode });

console.log('Listo.');
