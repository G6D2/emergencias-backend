const { Kafka } = require('kafkajs');
const { ServiceUnavailableError } = require('../errors/app-errors');
const { secureLog, summarizeEventForLog } = require('../security/secure-log');
const { EdaAuthClient } = require('./eda-auth-client');

const DEFAULT_EDA_TOKEN_URL = 'https://api.citypass-login.pp.ua/oauth/token';
const DEFAULT_EDA_CLIENT_ID = 'grupo5';

// Cliente del token client-credentials del Login Federado. Lo comparten el
// broker (SASL) y el schema registry del gateway (Bearer). null sin secreto.
function edaAuthClientFromEnv(env = process.env) {
  if (!env.EDA_OAUTH_CLIENT_SECRET) return null;
  return new EdaAuthClient({
    tokenUrl: env.EDA_OAUTH_TOKEN_URL || DEFAULT_EDA_TOKEN_URL,
    clientId: env.EDA_OAUTH_CLIENT_ID || DEFAULT_EDA_CLIENT_ID,
    clientSecret: env.EDA_OAUTH_CLIENT_SECRET,
  });
}

// SASL/OAUTHBEARER contra el broker del Grupo 1 (sección 6 del README del
// gateway): el token client-credentials sale del Login Federado y kafkajs
// vuelve a pedir uno al vencer (EdaAuthClient lo renueva antes). Solo se activa
// si está el secreto: sin él (local, docker-compose) se conecta como siempre.
function saslFromEnv(env = process.env, authClient = null) {
  if (!env.EDA_OAUTH_CLIENT_SECRET) return null;
  const client = authClient || edaAuthClientFromEnv(env);
  return {
    mechanism: 'oauthbearer',
    oauthBearerProvider: async () => ({ value: await client.getToken() }),
  };
}

class KafkaService {
  constructor(options = {}) {
    // KAFKA_ENABLED=false (Render, entornos sin broker): el servicio arranca
    // sin conectarse y publishEvent registra el evento en lugar de fallar.
    this.enabled =
      options.enabled !== undefined ? Boolean(options.enabled) : process.env.KAFKA_ENABLED !== 'false';
    const sasl = saslFromEnv(process.env, options.authClient);
    this.kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID || 'emergencias-backend',
      brokers: [process.env.KAFKA_BROKER || 'kafka:9092'],
      // En producción el broker del gateway es SASL_SSL.
      ...(sasl ? { sasl } : {}),
      ...(process.env.KAFKA_SSL === 'true' ? { ssl: true } : {}),
      connectionTimeout: 10000,
      requestTimeout: 25000,
      retry: {
        initialRetryTime: 300,
        retries: 8,
        maxRetryTime: 30000,
        multiplier: 2,
        randomizationFactor: 0.2,
      },
    });
    this.producer = null;
    this.connected = false;
  }

  isEnabled() {
    return this.enabled;
  }

  async connect() {
    if (!this.enabled) {
      secureLog('info', 'Kafka disabled via KAFKA_ENABLED=false — skipping connection');
      return false;
    }

    try {
      this.producer = this.kafka.producer({
        allowAutoTopicCreation: true,
        transactionTimeout: 30000,
      });
      await this.producer.connect();
      this.connected = true;
      secureLog('info', 'Kafka producer connected');
      return true;
    } catch (error) {
      secureLog('error', 'Kafka connection error', { message: error.message });
      secureLog('warn', 'Kafka unavailable — degraded mode');
      this.connected = false;
      return false;
    }
  }

  isConnected() {
    return this.connected && this.producer !== null;
  }

  async checkHealth() {
    const admin = this.kafka.admin({ retry: { retries: 0 } });

    try {
      await admin.connect();
      return true;
    } catch (error) {
      return false;
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

  async publishEvent(topic, value) {
    if (!this.enabled) {
      // Sin bus no se pierde la operacion de negocio: la emergencia ya quedo
      // persistida. Se deja constancia (sin lat/lng) de que el evento no salio.
      secureLog('warn', 'Kafka disabled — event not published', summarizeEventForLog(topic, value));
      return false;
    }

    if (!this.isConnected()) {
      throw new ServiceUnavailableError(
        `Kafka not connected. Event not published to ${topic}`
      );
    }

    try {
      await this.producer.send({
        topic,
        messages: [
          {
            key: null,
            value: JSON.stringify(value),
          },
        ],
      });
      // Nunca loguear el payload completo (puede traer lat/lng).
      secureLog('info', 'Event published', summarizeEventForLog(topic, value));
      return true;
    } catch (error) {
      this.connected = false;
      secureLog('error', `Error publishing event to ${topic}`, { message: error.message });
      throw error;
    }
  }

  async disconnect() {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
      this.connected = false;
    }
  }
}

module.exports = { KafkaService, saslFromEnv, edaAuthClientFromEnv };
