require('dotenv').config();
const { KafkaService } = require('./services/kafka.service');
const { getPool } = require('./db/pool');
const { EmergencyRepository } = require('./repositories/emergency.repository');
const { OfficerRepository } = require('./repositories/officer.repository');
const { createApp } = require('./app');
const { createAuthSetup } = require('./auth/setup');
const { createLocationCrypto } = require('./security/location-crypto');
const { startLocationRetentionJob } = require('./security/location-retention');
const { startKeepWarmJob } = require('./jobs/keep-warm');
const { secureLog } = require('./security/secure-log');
const { OutboxPublisher } = require('./services/outbox-publisher');

const PORT = process.env.PORT || 3000;

async function start() {
  // Valida la key al boot (falla temprano si falta o es inválida).
  const locationCrypto = createLocationCrypto();

  const auth = await createAuthSetup();
  const kafkaService = new KafkaService();
  const pool = getPool();
  const emergencyRepository = new EmergencyRepository(pool, { locationCrypto });
  const officerRepository = new OfficerRepository(pool);
  const outboxPublisher = new OutboxPublisher(pool, kafkaService);

  // Con KAFKA_ENABLED=false connect() no hace nada (ver KafkaService).
  kafkaService.connect().catch((err) => {
    secureLog('error', 'Initial Kafka connection failed', { message: err.message });
  });
  outboxPublisher.start();

  const retentionJob = startLocationRetentionJob(emergencyRepository);
  // Mantiene despiertos backend y frontend en horario de clase (Render free).
  const keepWarmJob = startKeepWarmJob();

  const app = createApp(kafkaService, emergencyRepository, {
    authenticate: auth.authenticate,
    devAuthRouter: auth.devAuthRouter,
    authMode: auth.mode,
    officerRepository,
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
    keepWarmJob.stop();
    outboxPublisher.stop();
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
