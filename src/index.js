require('dotenv').config();
const { KafkaService } = require('./services/kafka.service');
const { getPool } = require('./db/pool');
const { EmergencyRepository } = require('./repositories/emergency.repository');
const { OfficerRepository } = require('./repositories/officer.repository');
const { IncidentRepository } = require('./repositories/incident.repository');
const { CitizenProfileRepository } = require('./repositories/citizen-profile.repository');
const { createApp } = require('./app');
const { createAuthSetup } = require('./auth/setup');
const { createLocationCrypto } = require('./security/location-crypto');
const { startLocationRetentionJob } = require('./security/location-retention');
const { startCitizenProfileRetentionJob } = require('./security/citizen-profile-retention');
const { startIncidentDetectionJob } = require('./services/incident-detection-job');
const { startKeepWarmJob } = require('./jobs/keep-warm');
const { secureLog } = require('./security/secure-log');
const { OutboxPublisher } = require('./services/outbox-publisher');
const { GatewayPublisher } = require('./services/gateway-publisher');
const { EdaAuthClient } = require('./integracion/eda-auth-client');
const { buildIntegracionListener } = require('./integracion/bootstrap');

const PORT = process.env.PORT || 3000;

async function start() {
  // Valida la key al boot (falla temprano si falta o es inválida).
  const locationCrypto = createLocationCrypto();
  const pool = getPool();
  const { AuthUserRepository } = require('./repositories/auth-user.repository');
  const authUserRepository = new AuthUserRepository(pool);

  const auth = await createAuthSetup({ authUserRepository });
  const kafkaService = new KafkaService();
  const emergencyRepository = new EmergencyRepository(pool, { locationCrypto });
  const officerRepository = new OfficerRepository(pool);
  const incidentRepository = new IncidentRepository(pool, emergencyRepository);
  const citizenProfileRepository = new CitizenProfileRepository(pool, { locationCrypto });
  // ADR #25: EDA_PUBLISHER_MODE=gateway levanta un publisher HTTP contra el
  // gateway (POST /api/v1/event-types/{fqn}/events). Default sigue siendo
  // publicacion directa al broker Kafka (compatibilidad previa). El flip solo
  // tiene sentido una vez que esten los topics renombrados a FQN y los
  // payloads adaptados a {data} — hasta entonces el gateway responde 403/400.
  const publisherMode = (process.env.EDA_PUBLISHER_MODE || 'kafka').toLowerCase();
  let outboxActivePublisher = kafkaService;
  if (publisherMode === 'gateway') {
    const edaAuthClient = new EdaAuthClient();
    if (!edaAuthClient.isConfigured()) {
      secureLog('warn', 'EDA_PUBLISHER_MODE=gateway pero EdaAuthClient no configurado — fallback a Kafka');
    } else {
      outboxActivePublisher = new GatewayPublisher({ edaAuthClient });
      secureLog('info', 'OutboxPublisher usando GatewayPublisher (EDA_PUBLISHER_MODE=gateway)');
    }
  }
  const outboxPublisher = new OutboxPublisher(pool, kafkaService, { publisher: outboxActivePublisher });

  // Con KAFKA_ENABLED=false connect() no hace nada (ver KafkaService).
  kafkaService.connect().catch((err) => {
    secureLog('error', 'Initial Kafka connection failed', { message: err.message });
  });
  outboxPublisher.start();

  // Listener de integracion EDA (ADR #25). Deshabilitado por default:
  // KAFKA_CONSUMER_ENABLED=true + EDA_TOPIC_EVENTO_PUBLICADO/CANCELADO
  // lo prenden. Fuera de la ventana, es no-op.
  const integracionListener = buildIntegracionListener({ pool, kafkaService, locationCrypto });
  if (integracionListener.enabled) {
    integracionListener.start().catch((err) => {
      secureLog('error', 'Integracion listener fallo al arrancar', { message: err.message });
    });
  }

  const retentionJob = startLocationRetentionJob(emergencyRepository);
  const citizenPiiRetentionJob = startCitizenProfileRetentionJob(citizenProfileRepository);
  const incidentDetectionJob = startIncidentDetectionJob(emergencyRepository, incidentRepository, { pool });
  // Mantiene despiertos backend y frontend en horario de clase (Render free).
  const keepWarmJob = startKeepWarmJob();

  const app = createApp(kafkaService, emergencyRepository, {
    authenticate: auth.authenticate,
    devAuthRouter: auth.devAuthRouter,
    authMode: auth.mode,
    officerRepository,
    incidentRepository,
    citizenProfileRepository,
  });

  const server = app.listen(PORT, () => {
    secureLog('info', `Server running on port ${PORT}`);
    secureLog('info', `Health check: http://localhost:${PORT}/health`);
    secureLog('info', `Swagger UI: http://localhost:${PORT}/api-docs`);
    if (auth.mode === 'local') {
      secureLog('info', `Auth LOCAL — POST http://localhost:${PORT}/auth/login | /auth/register | /auth/dev/login`);
    } else {
      secureLog('info', `Auth IdP (${auth.config.issuer})`);
    }
  });

  const shutdown = async () => {
    retentionJob.stop();
    citizenPiiRetentionJob.stop();
    incidentDetectionJob.stop();
    keepWarmJob.stop();
    outboxPublisher.stop();
    server.close();
    await integracionListener.stop().catch(() => {});
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
