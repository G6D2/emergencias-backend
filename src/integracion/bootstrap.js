const { EventBus } = require('./event-bus');
const { MapperRegistry } = require('./mapper-registry');
const { Listener } = require('./listener');
const { EdaAuthClient } = require('./eda-auth-client');
const { EventosProcesadosRepository } = require('../repositories/eventos-procesados.repository');
const { createEventoComunitarioPublicadoMapper } = require('./mappers/evento-comunitario-publicado');
const { createEventoCanceladoMapper } = require('./mappers/evento-cancelado');
const { crearRegistroDisparadores } = require('../disparadores/registry');
const { activateAndDiscardStalePending } = require('./listener-activation');
const { secureLog } = require('../security/secure-log');

const DEFAULT_UMBRAL_CAPACIDAD = 500;

function parseUmbralCapacidad(env) {
  const umbralCapacidad = Number(env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA || DEFAULT_UMBRAL_CAPACIDAD);
  if (!Number.isFinite(umbralCapacidad) || umbralCapacidad <= 0) {
    throw new Error(`UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA invalido: ${env.UMBRAL_CAPACIDAD_COBERTURA_PREVENTIVA}`);
  }
  return umbralCapacidad;
}

// Mismo registro de mappers para el consumer de Kafka y para la carga manual.
function buildMapperRegistry({ env, locationCrypto, umbralCapacidad }) {
  const disparadores = crearRegistroDisparadores();
  const registry = new MapperRegistry();
  registry.register(
    'EventoComunitarioPublicado',
    createEventoComunitarioPublicadoMapper({
      umbralCapacidad,
      locationCrypto,
      userIdForExternal: env.EDA_EXTERNAL_USER_ID || 'eda-bus',
      disparador: disparadores.get('EventoComunitarioPublicado'),
    })
  );
  registry.register('EventoCancelado', createEventoCanceladoMapper());
  return registry;
}

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

  const umbralCapacidad = parseUmbralCapacidad(env);

  const edaAuthClient = new EdaAuthClient({
    authUrl: env.EDA_AUTH_URL,
    clientId: env.EDA_CLIENT_ID,
    clientSecret: env.EDA_CLIENT_SECRET,
  });
  if (!edaAuthClient.isConfigured()) {
    secureLog('warn', 'EdaAuthClient sin credenciales (EDA_AUTH_URL/EDA_CLIENT_ID/SECRET) — consumer sin SASL');
  }

  const registry = buildMapperRegistry({ env, locationCrypto, umbralCapacidad });

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
        // Issue #71: antes de levantar los consumers, descarta las PENDING
        // externas que quedaron colgadas antes de que exista bus. Idempotente
        // entre reinicios: solo la primera corrida toca emergencias.
        await activateAndDiscardStalePending({ pool });
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

// Entrada manual desde el tablero (ADR #25: mientras no haya consumer
// always-on, los mismos comandos se invocan a mano). Arma el mismo Listener
// sin EventBus: handleEvent no lo usa, asi que mapper, disparadores, dedup y
// transaccion son exactamente los del consumer. No depende de
// KAFKA_CONSUMER_ENABLED.
function buildIntegracionManual({ pool, locationCrypto, env = process.env }) {
  const registry = buildMapperRegistry({ env, locationCrypto, umbralCapacidad: parseUmbralCapacidad(env) });
  return new Listener(null, registry, {
    pool,
    eventosProcesadosRepo: new EventosProcesadosRepository(pool),
    ownNamespace: env.EDA_OWN_NAMESPACE,
  });
}

module.exports = { buildIntegracionListener, buildIntegracionManual, DEFAULT_UMBRAL_CAPACIDAD };
