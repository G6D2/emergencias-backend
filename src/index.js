require('dotenv').config();
const { KafkaService, edaAuthClientFromEnv, kafkaHealth } = require('./services/kafka.service');
const { getPool, closePool } = require('./db/pool');
const { EmergencyRepository } = require('./repositories/emergency.repository');
const { OfficerRepository } = require('./repositories/officer.repository');
const { IncidentRepository } = require('./repositories/incident.repository');
const { CitizenProfileRepository } = require('./repositories/citizen-profile.repository');
const { createApp } = require('./app');
const { createAuthSetup } = require('./auth/setup');
const { createLocationCrypto } = require('./security/location-crypto');
const { assertBusLocationCryptoAtBoot } = require('./security/bus-location-crypto');
const { startLocationRetentionJob } = require('./security/location-retention');
const { startCitizenProfileRetentionJob } = require('./security/citizen-profile-retention');
const { startIncidentDetectionJob } = require('./services/incident-detection-job');
const { startKeepWarmJob } = require('./jobs/keep-warm');
const { secureLog } = require('./security/secure-log');
const { OutboxPublisher, isOutboxPublisherEnabled } = require('./services/outbox-publisher');
const { GatewayPublisher } = require('./services/gateway-publisher');
const { createListeners, superviseListener, OutcomeFactory } = require('./listeners');
const { createEventDecoder, registryFromEnv } = require('./listeners/event-decoder');
const { EventosProcesadosRepository } = require('./repositories/eventos-procesados.repository');
const { PROGRAMAR_COBERTURA, createProgramarCoberturaHandler } = require('./listeners/cobertura-preventiva/handlers/programar-cobertura.handler');
const { CANCELAR_COBERTURA, createCancelarCoberturaHandler } = require('./listeners/cobertura-preventiva/handlers/cancelar-cobertura.handler');
const { CREAR_INTERVENCION, createCrearIntervencionHandler } = require('./listeners/reclamo-intervencion/handlers/crear-intervencion.handler');
const { CERRAR_INTERVENCION, createCerrarIntervencionHandler } = require('./listeners/reclamo-intervencion/handlers/cerrar-intervencion.handler');
const {
  REGISTRAR_CONTEXTO_ZONA,
  DAR_DE_BAJA_CONTEXTO_ZONA,
  createRegistrarContextoZonaHandler,
  createDarDeBajaContextoZonaHandler,
} = require('./listeners/cobertura-preventiva/handlers/contexto-zona.handler');
const { ContextoZonaRepository } = require('./repositories/contexto-zona.repository');
const { gracefulShutdown, closeServer } = require('./utils/graceful-shutdown');

const PORT = process.env.PORT || 3000;
// Tope del apagado ordenado. Render espera 30 s (default) entre el SIGTERM y
// el SIGKILL, así que sobra margen.
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function start() {
  // Valida la key al boot (falla temprano si falta o es inválida).
  const locationCrypto = createLocationCrypto();
  // Clave de bus: distinta a la de DB; si está mal configurada tumba el boot.
  assertBusLocationCryptoAtBoot();
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

  // El producer solo lo usa el outbox: lo conecta el publisher en su primer
  // poll. Apagado, no queda una conexión ociosa al bus.
  if (isOutboxPublisherEnabled()) {
    outboxPublisher.start();
  } else {
    secureLog('info', 'Outbox publisher apagado (OUTBOX_PUBLISHER_ENABLED no es true): el producer no se conecta');
  }

  // Listeners de eventos externos. Apagados por default: se prenden con
  // KAFKA_CONSUMER_ENABLED=true (cada uno necesita ademas su topic).
  const eventosProcesadosRepo = new EventosProcesadosRepository(pool);
  const outcomeFactory = new OutcomeFactory(pool, { dedupRepo: eventosProcesadosRepo });
  outcomeFactory.register(PROGRAMAR_COBERTURA, createProgramarCoberturaHandler({ emergencyRepository }));
  outcomeFactory.register(CANCELAR_COBERTURA, createCancelarCoberturaHandler({ emergencyRepository }));
  outcomeFactory.register(CREAR_INTERVENCION, createCrearIntervencionHandler({ emergencyRepository }));
  outcomeFactory.register(CERRAR_INTERVENCION, createCerrarIntervencionHandler({ emergencyRepository }));
  // Contexto de zona: mientras dura un evento comunitario, las emergencias
  // que se crean dentro de su radio suben un nivel de prioridad de despacho;
  // mientras dura una alerta climática, las emergencias abiertas de sus
  // barrios, para los tipos que afecta.
  const contextoZonaRepository = new ContextoZonaRepository(pool);
  outcomeFactory.register(REGISTRAR_CONTEXTO_ZONA, createRegistrarContextoZonaHandler({ contextoZonaRepository }));
  outcomeFactory.register(DAR_DE_BAJA_CONTEXTO_ZONA, createDarDeBajaContextoZonaHandler({ contextoZonaRepository }));

  const listeners = process.env.KAFKA_CONSUMER_ENABLED === 'true'
    ? createListeners(kafkaService.kafka, {
      factory: outcomeFactory,
      decoder: createEventDecoder({ registry: registryFromEnv(process.env, { authClient: edaAuthClient }) }),
    })
    : [];
  // Si un listener no arranca (o se cae sin que kafkajs lo reinicie), se
  // reintenta con backoff en vez de quedar muerto hasta el próximo deploy.
  const listenerHandles = listeners.map((listener) => superviseListener(listener));

  const retentionJob = startLocationRetentionJob(emergencyRepository);
  const citizenPiiRetentionJob = startCitizenProfileRetentionJob(citizenProfileRepository);
  const incidentDetectionJob = startIncidentDetectionJob(emergencyRepository, incidentRepository, { pool });
  // Mantiene despiertos backend y frontend en horario de clase (Render free).
  const keepWarmJob = startKeepWarmJob();

  const app = createApp(kafkaService, emergencyRepository, {
    authenticate: auth.authenticate,
    devAuthRouter: auth.devAuthRouter,
    // GET /health: estado en memoria, sin conectar nada.
    health: () => kafkaHealth(kafkaService, {
      outbox: outboxPublisher.health(),
      listeners: listenerHandles.map((handle) => handle.status()),
    }),
    officerRepository,
    incidentRepository,
    citizenProfileRepository,
    // GET /api/contextos-zona/activos: banner de alertas climáticas.
    contextoZonaRepository,
  });

  const server = app.listen(PORT, () => {
    secureLog('info', `Server running on port ${PORT}`);
    secureLog('info', `Health check: http://localhost:${PORT}/health`);
    secureLog('info', `Swagger UI: http://localhost:${PORT}/api-docs`);
    if (auth.mode === 'local') {
      secureLog('info', `Auth LOCAL — POST http://localhost:${PORT}/auth/login | /auth/register | /auth/dev/login`);
    } else if (auth.mode === 'hybrid') {
      secureLog('info', `Auth HYBRID — Login Federado (${auth.config.federated.issuer}) + local (${auth.config.local.issuer}): /auth/login | /auth/register | /auth/dev/login`);
    } else {
      secureLog('info', `Auth IdP (${auth.config.issuer})`);
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    secureLog('info', `${signal} recibido: apagando`);
    retentionJob.stop();
    citizenPiiRetentionJob.stop();
    incidentDetectionJob.stop();
    keepWarmJob.stop();
    outboxPublisher.stop();
    // Primero deja de aceptar requests y espera los que están en curso; el
    // pool se cierra al final, cuando ya nadie lo usa.
    const exitCode = await gracefulShutdown([
      { name: 'el servidor HTTP', run: () => closeServer(server) },
      { name: 'los listeners', run: () => Promise.all(listenerHandles.map((handle) => handle.stop())) },
      { name: 'el producer de Kafka', run: () => kafkaService.disconnect() },
      { name: 'el pool de Postgres', run: () => closePool() },
    ], { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(exitCode);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((error) => {
  secureLog('error', 'Failed to start server', { message: error.message });
  process.exit(1);
});
