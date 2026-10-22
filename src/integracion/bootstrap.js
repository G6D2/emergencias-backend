const { EventBus } = require('./event-bus');
const { MapperRegistry } = require('./mapper-registry');
const { Listener } = require('./listener');
const { EdaAuthClient } = require('./eda-auth-client');
const { EventosProcesadosRepository } = require('../repositories/eventos-procesados.repository');
const { createEventoComunitarioPublicadoMapper } = require('./mappers/evento-comunitario-publicado');
const { createEventoCanceladoMapper } = require('./mappers/evento-cancelado');
const { secureLog } = require('../security/secure-log');

const DEFAULT_UMBRAL_CAPACIDAD = 500;

// Plumbing de arranque del listener de integracion. index.js lo llama una
// vez y recibe un objeto con start/stop. Si KAFKA_CONSUMER_ENABLED es
// false (default), devuelve stops no-op y nunca toca kafkajs.
function buildIntegracionListener({ pool, kafkaService, locationCrypto, env = process.env }) {
  const consumerEnabled = env.KAFKA_CONSUMER_ENABLED === 'true';
  const noop = {
    async start() { return false; },
    async stop() {},
    enabled: false,
  };

  if (!consumerEnabled) {
    secureLog('info', 'Listener de integracion EDA deshabilitado (KAFKA_CONSUMER_ENABLED!=true)');
    return noop;
  }

  const topicPublicado = env.EDA_TOPIC_EVENTO_PUBLICADO;
  const topicCancelado = env.EDA_TOPIC_EVENTO_CANCELADO;
  if (!topicPublicado && !topicCancelado) {
    secureLog('warn', 'Listener EDA habilitado pero no hay topics (EDA_TOPIC_EVENTO_PUBLICADO/CANCELADO)');
    return noop;
  }

  const umbralCapacidad = Number(env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA || DEFAULT_UMBRAL_CAPACIDAD);
  if (!Number.isFinite(umbralCapacidad) || umbralCapacidad <= 0) {
    throw new Error(`UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA invalido: ${env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA}`);
  }

  const edaAuthClient = new EdaAuthClient({
    authUrl: env.EDA_AUTH_URL,
    clientId: env.EDA_CLIENT_ID,
    clientSecret: env.EDA_CLIENT_SECRET,
  });
  if (!edaAuthClient.isConfigured()) {
    secureLog('warn', 'EdaAuthClient sin credenciales (EDA_AUTH_URL/EDA_CLIENT_ID/SECRET) — consumer sin SASL');
  }

  const registry = new MapperRegistry();
  registry.register(
    'EventoComunitarioPublicado',
    createEventoComunitarioPublicadoMapper({
      umbralCapacidad,
      locationCrypto,
      userIdForExternal: env.EDA_EXTERNAL_USER_ID || 'eda-bus',
    })
  );
  registry.register('EventoCancelado', createEventoCanceladoMapper());

  const eventBus = new EventBus(kafkaService, {
    consumerEnabled: true,
    edaAuthClient: edaAuthClient.isConfigured() ? edaAuthClient : null,
    consumerGroupId: env.KAFKA_GROUP_ID || 'emergencias-integracion',
  });

  const eventosProcesadosRepo = new EventosProcesadosRepository(pool);

  const topics = [topicPublicado, topicCancelado].filter(Boolean);
  const listener = new Listener(eventBus, registry, {
    topics,
    pool,
    eventosProcesadosRepo,
    groupId: env.KAFKA_GROUP_ID,
    ownNamespace: env.EDA_OWN_NAMESPACE,
  });

  secureLog('info', 'Listener de integracion EDA configurado', {
    topics,
    umbralCapacidad,
    hasAuth: edaAuthClient.isConfigured(),
  });

  return {
    enabled: true,
    async start() {
      try {
        return await listener.start();
      } catch (error) {
        secureLog('error', 'Listener EDA fallo al arrancar — queda apagado', { message: error.message });
        return false;
      }
    },
    async stop() {
      await listener.stop();
    },
  };
}

module.exports = { buildIntegracionListener, DEFAULT_UMBRAL_CAPACIDAD };
