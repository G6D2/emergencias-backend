/**
 * Entry point de migrations que usa el pipeline de CI/CD.
 * Delega a Flyway (`scripts/migrate.js` + `db/migrations/`).
 *
 * El schema vive en `db/migrations/V1__create_emergencias.sql`
 * (tabla `emergencies`, latitude/longitude, status CREATED).
 */
require('dotenv').config();

const path = require('path');
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

runFlyway(connectionInfo, {
  command,
  migrationsDir,
  sslmode,
});

console.log('All migrations up to date');
