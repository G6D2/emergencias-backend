require('dotenv').config();
const { KafkaService, edaAuthClientFromEnv } = require('./services/kafka.service');
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
const { OutboxPublisher, isOutboxPublisherEnabled } = require('./services/outbox-publisher');
const { GatewayPublisher } = require('./services/gateway-publisher');
const { createListeners, OutcomeFactory } = require('./listeners');
const { createEventDecoder, registryFromEnv } = require('./listeners/event-decoder');
const { EventosProcesadosRepository } = require('./repositories/eventos-procesados.repository');
const { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler } = require('./listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { CANCELAR_COBERTURA, createCancelarCoberturaHandler } = require('./listeners/cobertura-preventiva/handlers/cancelar-cobertura.handler');

const PORT = process.env.PORT || 3000;

async function start() {
  // Valida la key al boot (falla temprano si falta o es inválida).
  const locationCrypto = createLocationCrypto();
  const pool = getPool();
  const { AuthUserRepository } = require('./repositories/auth-user.repository');
  const authUserRepository = new AuthUserRepository(pool);

  const auth = await createAuthSetup({ authUserRepository });
  const edaAuthClient = edaAuthClientFromEnv();
  const kafkaService = new KafkaService({ authClient: edaAuthClient });
  const emergencyRepository = new EmergencyRepository(pool, { locationCrypto });
  const officerRepository = new OfficerRepository(pool);
  const incidentRepository = new IncidentRepository(pool, emergencyRepository);
  const citizenProfileRepository = new CitizenProfileRepository(pool, { locationCrypto });
  // Issue #74: EDA_PUBLISHER_MODE=gateway activa publicacion HTTP al gateway
  // via GatewayPublisher. Default kafka = KafkaService directo (sin cambios).
  // Secret de EDA_OAUTH_CLIENT_SECRET viene por privado de Delfina (G2); jamas
  // en el repo. Hasta que llegue y se setee en Render, EDA_PUBLISHER_MODE queda
  // en 'kafka' (o unset) y el GatewayPublisher no se usa.
  let publisher;
  if (process.env.EDA_PUBLISHER_MODE === 'gateway') {
    if (!edaAuthClient || !edaAuthClient.isConfigured()) {
      secureLog('warn', 'EDA_PUBLISHER_MODE=gateway pero EdaAuthClient no esta configurado — se cae a KafkaService', {});
      publisher = kafkaService;
    } else {
      publisher = new GatewayPublisher(edaAuthClient);
      secureLog('info', 'GatewayPublisher activo (EDA_PUBLISHER_MODE=gateway)', { apiUrl: publisher.baseUrl });
    }
  } else {
    publisher = kafkaService;
  }
  const outboxPublisher = new OutboxPublisher(pool, kafkaService, { publisher });

  // Con KAFKA_ENABLED=false connect() no hace nada (ver KafkaService).
  kafkaService.connect().catch((err) => {
    secureLog('error', 'Initial Kafka connection failed', { message: err.message });
  });
  if (isOutboxPublisherEnabled()) {
    outboxPublisher.start();
  } else {
    secureLog('info', 'Outbox publisher apagado (OUTBOX_PUBLISHER_ENABLED=false)');
  }

  // Listeners de eventos externos. Apagados por default: se prenden con
  // KAFKA_CONSUMER_ENABLED=true (cada uno necesita ademas su topic).
  const eventosProcesadosRepo = new EventosProcesadosRepository(pool);
  const outcomeFactory = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
  outcomeFactory.register(PROGRAMAR_COBERTURA, createProgramarCoberturaHandler({ emergencyRepository }));
  outcomeFactory.register(CANCELAR_COBERTURA, createCancelarCoberturaHandler({ emergencyRepository }));

  const listeners = process.env.KAFKA_CONSUMER_ENABLED === 'true'
    ? createListeners(kafkaService.kafka, {
      factory: outcomeFactory,
      decoder: createEventDecoder({ registry: registryFromEnv(process.env, { authClient: edaAuthClient }) }),
    })
    : [];
  for (const listener of listeners) {
    listener.start().catch((err) => {
      secureLog('error', 'Listener fallo al arrancar', { listener: listener.constructor.name, message: err.message });
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
    await Promise.all(listeners.map((l) => l.stop().catch(() => {})));
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
