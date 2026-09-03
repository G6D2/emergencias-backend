require('dotenv').config();
const { KafkaService } = require('./services/kafka.service');
const { getPool } = require('./db/pool');
const { EmergencyRepository } = require('./repositories/emergency.repository');
const { createApp } = require('./app');
const { createAuthSetup } = require('./auth/setup');
const { createLocationCrypto } = require('./security/location-crypto');
const { startLocationRetentionJob } = require('./security/location-retention');
const { secureLog } = require('./security/secure-log');

const PORT = process.env.PORT || 3000;

async function start() {
  // Valida la key al boot (falla temprano si falta o es inválida).
  const locationCrypto = createLocationCrypto();

  const auth = await createAuthSetup();
  const kafkaService = new KafkaService();
  const emergencyRepository = new EmergencyRepository(getPool(), { locationCrypto });

  if (process.env.KAFKA_ENABLED === 'false') {
    secureLog('info', 'Kafka disabled via KAFKA_ENABLED=false — skipping connection');
  } else {
    kafkaService.connect().catch((err) => {
      secureLog('error', 'Initial Kafka connection failed', { message: err.message });
    });
  }

  const retentionJob = startLocationRetentionJob(emergencyRepository);

  const app = createApp(kafkaService, emergencyRepository, {
    authenticate: auth.authenticate,
    devAuthRouter: auth.devAuthRouter,
    authMode: auth.mode,
  });

  const server = app.listen(PORT, () => {
    secureLog('info', `Server running on port ${PORT}`);
    secureLog('info', `Health check: http://localhost:${PORT}/health`);
    secureLog('info', `Swagger UI: http://localhost:${PORT}/api-docs`);
    if (auth.mode === 'local') {
      secureLog('info', `Auth LOCAL — POST http://localhost:${PORT}/auth/dev/login`);
    } else {
      secureLog('info', `Auth IdP (${auth.config.issuer})`);
    }
  });

  const shutdown = async () => {
    retentionJob.stop();
    server.close();
    await kafkaService.disconnect().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  secureLog('error', 'Failed to start server', { message: error.message });
  process.exit(1);
});
